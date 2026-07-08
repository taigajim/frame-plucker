// Frame Plucker
// Uses ffmpeg to remove repeated held frames from file-backed video in After Effects.

(function (thisObj) {
  var HARD_CAP = 1500;
  var SETTINGS_SECTION = "FramePlucker";
  var SETTINGS_FFMPEG_PATH = "ffmpegPath";
  var MANAGED_DIR_NAME = "Frame Plucker";

// === CORE BEGIN ===
  var MIN_PHASE_SAMPLES = 6;
  var PERIOD_MIN = 2;
  var PERIOD_MAX = 32;
  var MAX_PHASES = 8;
  // Adjusted from 0.05 to 0.04: stutter-23in24 has one duplicate per 24 frames,
  // so the 5th percentile lands in the motion class and prevents separation.
  var NOISE_FLOOR_PERCENTILE = 0.04;
  var NOISE_FLOOR_SAMPLES = 5;
  // Adjusted from 3 to 5: stutter-16in24 missed the required 90% duplicate-candidate
  // coverage because several codec-noisy duplicate samples landed between floor*3 and floor*5.
  var DUP_FLOOR_MULTIPLIER = 5;
  var DUP_FLOOR_OFFSET = 0.02;
  var COMB_SCORE_GATE = 0.6;
  var HARMONIC_TOLERANCE = 0.05;
  var PHASE_DUP_RATE = 0.8;
  var MAX_RESIDUAL_DUP = 0.10;
  var DRIFT_MIN_DUPS = 12;
  var DRIFT_MAX_RUN = 2;
  var DRIFT_MIN_GAP = 2;
  var DRIFT_MAX_GAP = 12;
  var DRIFT_GAP_REGULARITY = 0.6;
  var SCATTER_MIN_DUPS = 2;
  var SCATTER_MAX_FRACTION = 0.2;
  var SCATTER_GAP_RATIO = 3;
  // A 4fps-in-24 cadence creates runs of 5 duplicates and remains cadence evidence;
  // runs of 6+ are treated as freeze holds, so lower content rates are out of scope.
  var FREEZE_MIN_RUN = 6;
  // A real freeze can briefly rise above the duplicate cutoff for a frame or two
  // (codec flicker), splitting one hold into a freeze + a short run + a freeze.
  // Short duplicate runs within this many motion frames of a freeze are absorbed
  // into it, so the flicker is not miscounted as cadence residual. Kept at 2 so a
  // genuine cadence duplicate 3+ frames before a freeze onset is left alone.
  var FREEZE_MERGE_GAP = 2;
  function shellQuote(value, isWin) {
    var text = String(value);
    if (isWin) {
      return "\"" + text.replace(/"/g, "\"\"") + "\"";
    }
    var quoted = text.replace(/(["\\$])/g, "\\$1");
    var tick = String.fromCharCode(96);
    return "\"" + quoted.replace(new RegExp(tick, "g"), "\\" + tick) + "\"";
  }
  function parseDiffMetrics(output) {
    var lines = String(output).split(/\r\n|\r|\n/);
    var metrics = [];
    var currentFrame = null;

    for (var i = 0; i < lines.length; i++) {
      var frameMatch = lines[i].match(/frame:\s*(\d+)/);
      if (frameMatch) {
        currentFrame = parseInt(frameMatch[1], 10);
        continue;
      }
      var valueMatch = lines[i].match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
      if (valueMatch && currentFrame !== null) {
        metrics.push({ frame: currentFrame, value: parseFloat(valueMatch[1]) });
        currentFrame = null;
      }
    }
    return metrics;
  }
  function lastNonEmptyLines(text, count) {
    var lines = String(text).split(/\r\n|\r|\n/);
    var kept = [];
    for (var i = lines.length - 1; i >= 0 && kept.length < count; i--) {
      if (String(lines[i]).replace(/\s/g, "") !== "") kept.unshift(lines[i]);
    }
    return kept.join("\n");
  }
  function resolveSourceSelection(candidates) {
    if (!candidates.length) return { error: "none" };

    for (var rule = 1; rule <= 4; rule++) {
      var firstIndex = -1;
      var ids = {};
      var distinct = 0;
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].rule === rule) {
          if (firstIndex < 0) firstIndex = i;
          var id = String(candidates[i].id);
          if (!ids[id]) {
            ids[id] = true;
            distinct++;
          }
        }
      }
      if (firstIndex >= 0) {
        if (distinct === 1) return { index: firstIndex };
        return { error: "multiple" };
      }
    }

    return { error: "none" };
  }
  function percentile(values, p) {
    if (!values.length) return 0;
    var sorted = values.slice(0).sort(function (a, b) { return a - b; });
    var index = Math.floor((sorted.length - 1) * p);
    if (index < 0) index = 0;
    if (index >= sorted.length) index = sorted.length - 1;
    return sorted[index];
  }
  function median(values) {
    return percentile(values, 0.5);
  }
  function getMetricValues(metrics) {
    var values = [];
    for (var i = 0; i < metrics.length; i++) values.push(metrics[i].value);
    return values;
  }
  function estimateNoiseFloor(values) {
    return percentile(values, NOISE_FLOOR_PERCENTILE);
  }
  function estimateSmallestMedianNoiseFloor(values) {
    if (!values.length) return 0;
    var sorted = values.slice(0).sort(function (a, b) { return a - b; });
    var count = Math.min(NOISE_FLOOR_SAMPLES, sorted.length);
    var smallest = [];
    for (var i = 0; i < count; i++) smallest.push(sorted[i]);
    return median(smallest);
  }
  function duplicateCutoff(floor) {
    return Math.max(floor * DUP_FLOOR_MULTIPLIER, floor + DUP_FLOOR_OFFSET);
  }
  function analyzeDuplicateClassWithFloor(metrics, floor) {
    var cutoff = duplicateCutoff(floor);
    var dupValues = [];
    var motionValues = [];
    for (var i = 0; i < metrics.length; i++) {
      if (metrics[i].value <= cutoff) dupValues.push(metrics[i].value);
      else motionValues.push(metrics[i].value);
    }
    var dupMedian = dupValues.length ? median(dupValues) : 0;
    var motionMedian = motionValues.length ? median(motionValues) : 0;
    var separable = dupValues.length > 0 &&
      motionValues.length > 0 &&
      dupMedian <= 0.25 * motionMedian &&
      motionMedian >= floor + 0.05;
    return { floor: floor, cutoff: cutoff, dupMedian: dupMedian, motionMedian: motionMedian, dupCount: dupValues.length, motionCount: motionValues.length, separable: separable };
  }
  function analyzeDuplicateClass(metrics) {
    var values = getMetricValues(metrics);
    var percentileFloor = estimateNoiseFloor(values);
    var percentileAnalysis = analyzeDuplicateClassWithFloor(metrics, percentileFloor);
    if (percentileAnalysis.separable) return percentileAnalysis;

    var smallestMedianFloor = estimateSmallestMedianNoiseFloor(values);
    if (smallestMedianFloor !== percentileFloor) {
      var smallestMedianAnalysis = analyzeDuplicateClassWithFloor(metrics, smallestMedianFloor);
      if (smallestMedianAnalysis.separable) return smallestMedianAnalysis;
    }

    return percentileAnalysis;
  }
  function isDuplicateMetric(metric, analysis) {
    return metric.value <= analysis.cutoff;
  }
  function collectDupRuns(metrics, analysis) {
    // Contiguous runs of duplicate-candidate frames, as index ranges into metrics.
    var runs = [];
    var startIndex = -1;
    var length = 0;
    for (var i = 0; i < metrics.length; i++) {
      if (isDuplicateMetric(metrics[i], analysis)) {
        if (length > 0 && metrics[i].frame === metrics[i - 1].frame + 1) {
          length++;
        } else {
          if (length > 0) runs.push({ startIndex: startIndex, length: length });
          startIndex = i;
          length = 1;
        }
      } else {
        if (length > 0) runs.push({ startIndex: startIndex, length: length });
        startIndex = -1;
        length = 0;
      }
    }
    if (length > 0) runs.push({ startIndex: startIndex, length: length });
    return runs;
  }

  function runGap(metrics, a, b) {
    // Number of non-duplicate (motion) frames between two runs, order-independent.
    var aStart = metrics[a.startIndex].frame;
    var aEnd = metrics[a.startIndex + a.length - 1].frame;
    var bStart = metrics[b.startIndex].frame;
    var bEnd = metrics[b.startIndex + b.length - 1].frame;
    if (bStart > aEnd) return bStart - aEnd - 1;
    if (aStart > bEnd) return aStart - bEnd - 1;
    return 0;
  }

  function splitFreezeSpans(metrics, analysis) {
    var working = [];
    var freezes = [];
    if (!metrics.length) return { working: working, freezes: freezes };

    var runs = collectDupRuns(metrics, analysis);
    var frozen = [];
    var i;
    for (i = 0; i < metrics.length; i++) frozen[i] = false;

    if (analysis.floor > 0) {
      var isFreeze = [];
      var r;
      for (r = 0; r < runs.length; r++) isFreeze[r] = runs[r].length >= FREEZE_MIN_RUN;

      // Absorb short duplicate runs that are freeze flicker (within
      // FREEZE_MERGE_GAP motion frames of a freeze). Iterate so a flicker run
      // wedged between two freezes links the whole hold together.
      var changed = true;
      while (changed) {
        changed = false;
        for (var a = 0; a < runs.length; a++) {
          // Only multi-frame runs are flicker; an isolated single near a freeze
          // is more likely a cadence duplicate, so never absorb length-1 runs.
          if (isFreeze[a] || runs[a].length < 2) continue;
          for (var b = 0; b < runs.length; b++) {
            if (!isFreeze[b]) continue;
            if (runGap(metrics, runs[a], runs[b]) <= FREEZE_MERGE_GAP) {
              isFreeze[a] = true;
              changed = true;
              break;
            }
          }
        }
      }

      // Mark frozen indices for freeze runs, plus the small motion gaps between
      // adjacent freeze runs so each hold becomes one contiguous span.
      for (var f = 0; f < runs.length; f++) {
        if (!isFreeze[f]) continue;
        for (var idx = runs[f].startIndex; idx < runs[f].startIndex + runs[f].length; idx++) frozen[idx] = true;
      }
      for (var g = 1; g < runs.length; g++) {
        if (isFreeze[g] && isFreeze[g - 1] && runGap(metrics, runs[g - 1], runs[g]) <= FREEZE_MERGE_GAP) {
          var gapStart = runs[g - 1].startIndex + runs[g - 1].length;
          var gapEnd = runs[g].startIndex;
          for (var m = gapStart; m < gapEnd; m++) frozen[m] = true;
        }
      }
    }

    // Emit contiguous frozen spans as freezes; everything else is working.
    var spanStart = -1;
    for (i = 0; i < metrics.length; i++) {
      if (frozen[i]) {
        if (spanStart < 0) spanStart = i;
      } else {
        if (spanStart >= 0) {
          freezes.push({ start: metrics[spanStart].frame, length: metrics[i - 1].frame - metrics[spanStart].frame + 1 });
          spanStart = -1;
        }
        working.push(metrics[i]);
      }
    }
    if (spanStart >= 0) {
      freezes.push({ start: metrics[spanStart].frame, length: metrics[metrics.length - 1].frame - metrics[spanStart].frame + 1 });
    }

    return { working: working, freezes: freezes };
  }
  function phaseDupRates(metrics, period, analysis) {
    var counts = [];
    var dupCounts = [];
    var rates = [];
    for (var p = 0; p < period; p++) {
      counts[p] = 0;
      dupCounts[p] = 0;
    }
    for (var i = 0; i < metrics.length; i++) {
      var phase = ((metrics[i].frame % period) + period) % period;
      counts[phase]++;
      if (isDuplicateMetric(metrics[i], analysis)) dupCounts[phase]++;
    }
    for (var phaseIndex = 0; phaseIndex < period; phaseIndex++) {
      if (counts[phaseIndex] >= MIN_PHASE_SAMPLES) {
        rates[phaseIndex] = dupCounts[phaseIndex] / counts[phaseIndex];
      } else {
        rates[phaseIndex] = null;
      }
    }
    return { counts: counts, dupCounts: dupCounts, rates: rates };
  }
  function combScoreForPeriod(metrics, period, analysis) {
    var phaseStats = phaseDupRates(metrics, period, analysis);
    var valid = 0;
    var minDupRate = 2;
    var maxRestRate = -1;
    var firstDupPhase = -1;
    for (var phase = 0; phase < period; phase++) {
      var rate = phaseStats.rates[phase];
      if (rate !== null) {
        valid++;
        if (rate >= PHASE_DUP_RATE) {
          if (rate < minDupRate) minDupRate = rate;
          if (firstDupPhase < 0) firstDupPhase = phase;
        } else {
          if (rate > maxRestRate) maxRestRate = rate;
        }
      }
    }
    if (valid < 2 || firstDupPhase < 0 || maxRestRate < 0) {
      return { period: period, score: -1, maxPhase: -1 };
    }
    return { period: period, score: minDupRate - maxRestRate, maxPhase: firstDupPhase };
  }

  function detectPeriodWithAnalysis(metrics, analysis) {
    if (!analysis.separable) {
      return { hasPeriod: false, analysis: analysis, reason: "not_separable" };
    }

    var scores = [];
    var best = null;
    for (var period = PERIOD_MIN; period <= PERIOD_MAX; period++) {
      var scored = combScoreForPeriod(metrics, period, analysis);
      scores.push(scored);
      if (!best || scored.score > best.score) best = scored;
    }

    if (!best || best.score < COMB_SCORE_GATE) {
      return { hasPeriod: false, analysis: analysis, scores: scores, best: best, reason: "weak_period" };
    }

    for (var divisor = PERIOD_MIN; divisor < best.period; divisor++) {
      if (best.period % divisor === 0) {
        var divisorScore = null;
        for (var scoreIndex = 0; scoreIndex < scores.length; scoreIndex++) {
          if (scores[scoreIndex].period === divisor) {
            divisorScore = scores[scoreIndex];
            break;
          }
        }
        if (divisorScore && divisorScore.score >= best.score - HARMONIC_TOLERANCE) {
          best = divisorScore;
          break;
        }
      }
    }

    return { hasPeriod: true, period: best.period, score: best.score, analysis: analysis, scores: scores };
  }
  function detectPeriod(metrics) {
    return detectPeriodWithAnalysis(metrics, analyzeDuplicateClass(metrics));
  }

  function selectPhasesForPeriod(metrics, period, analysis, maxPhases) {
    var phaseStats = phaseDupRates(metrics, period, analysis);
    var selected = [];

    for (var phaseIndex = 0; phaseIndex < period; phaseIndex++) {
      if (phaseStats.rates[phaseIndex] !== null && phaseStats.rates[phaseIndex] >= PHASE_DUP_RATE) {
        selected.push(phaseIndex);
      }
    }

    selected.sort(function (a, b) { return a - b; });
    return selected;
  }

  function sliceMetricsByFrame(metrics, startFrame, endFrame) {
    var sliced = [];
    for (var i = 0; i < metrics.length; i++) {
      if (metrics[i].frame >= startFrame && metrics[i].frame < endFrame) sliced.push(metrics[i]);
    }
    return sliced;
  }

  function countMotionMetrics(metrics, analysis) {
    var count = 0;
    for (var i = 0; i < metrics.length; i++) {
      if (!isDuplicateMetric(metrics[i], analysis)) count++;
    }
    return count;
  }

  function samePhaseSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function intersectPhaseSets(a, b) {
    var result = [];
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        if (a[i] === b[j]) {
          result.push(a[i]);
          break;
        }
      }
    }
    return result;
  }

  function residualDuplicateRate(metrics, period, analysis, phases) {
    var dupTotal = 0;
    var residual = 0;
    for (var i = 0; i < metrics.length; i++) {
      if (isDuplicateMetric(metrics[i], analysis)) {
        var phase = ((metrics[i].frame % period) + period) % period;
        dupTotal++;
        if (!phaseListContains(phases, phase)) residual++;
      }
    }
    return dupTotal ? residual / dupTotal : 0;
  }

  function crossSectionConfidence(metrics, period, analysis, phases, maxPhases) {
    if (!phases.length || !metrics.length) {
      return { confidence: "none", phases: [] };
    }

    var firstFrame = metrics[0].frame;
    var lastFrame = metrics[metrics.length - 1].frame + 1;
    var span = Math.max(1, lastFrame - firstFrame);
    var sections = Math.floor(metrics.length / (period * MIN_PHASE_SAMPLES));
    if (sections < 1) sections = 1;
    if (sections > 3) sections = 3;
    var evaluated = [];

    for (var section = 0; section < sections; section++) {
      var start = firstFrame + Math.floor(span * section / sections);
      var end = section === sections - 1 ? lastFrame : firstFrame + Math.floor(span * (section + 1) / sections);
      var sectionMetrics = sliceMetricsByFrame(metrics, start, end);
      if (countMotionMetrics(sectionMetrics, analysis) < 2 * period) continue;
      var sectionPhases = selectPhasesForPeriod(sectionMetrics, period, analysis, maxPhases);
      if (sectionPhases.length) evaluated.push(sectionPhases);
    }

    if (!evaluated.length) {
      return { confidence: "none", phases: [] };
    }

    var allSame = true;
    for (var i = 0; i < evaluated.length; i++) {
      if (!samePhaseSet(evaluated[i], phases)) allSame = false;
    }
    if (allSame && evaluated.length >= 2) {
      return { confidence: "high", phases: phases };
    }
    if (allSame) return { confidence: "medium", phases: phases };

    var intersection = phases.slice(0);
    for (var j = 0; j < evaluated.length; j++) {
      intersection = intersectPhaseSets(intersection, evaluated[j]);
    }
    if (intersection.length) {
      return { confidence: "medium", phases: intersection };
    }

    return { confidence: "none", phases: [] };
  }

  function collectDuplicateFrames(metrics, analysis) {
    var frames = [];
    for (var i = 0; i < metrics.length; i++) {
      if (isDuplicateMetric(metrics[i], analysis)) frames.push(metrics[i].frame);
    }
    return frames;
  }

  function duplicateGaps(dupFrames) {
    var gaps = [];
    for (var i = 1; i < dupFrames.length; i++) gaps.push(dupFrames[i] - dupFrames[i - 1]);
    return gaps;
  }

  function maxConsecutiveDuplicateRun(dupFrames) {
    if (!dupFrames.length) return 0;
    var maxRun = 1;
    var run = 1;
    for (var i = 1; i < dupFrames.length; i++) {
      if (dupFrames[i] === dupFrames[i - 1] + 1) {
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 1;
      }
    }
    return maxRun;
  }

  function detectDriftCadence(metrics, analysis) {
    var dupFrames = collectDuplicateFrames(metrics, analysis);
    if (dupFrames.length < DRIFT_MIN_DUPS) return { hasCadence: false, reason: "drift_too_few_duplicates", dupFrames: dupFrames };
    if (maxConsecutiveDuplicateRun(dupFrames) > DRIFT_MAX_RUN) return { hasCadence: false, reason: "drift_duplicate_run", dupFrames: dupFrames };

    var gaps = duplicateGaps(dupFrames);
    if (!gaps.length) return { hasCadence: false, reason: "drift_too_few_gaps", dupFrames: dupFrames };
    var medianGap = median(gaps);
    if (medianGap < DRIFT_MIN_GAP || medianGap > DRIFT_MAX_GAP) return { hasCadence: false, reason: "drift_gap_out_of_range", dupFrames: dupFrames, medianGap: medianGap };

    var regular = 0;
    for (var i = 0; i < gaps.length; i++) {
      if (gaps[i] >= medianGap - 1 && gaps[i] <= medianGap + 1) regular++;
    }
    if (regular / gaps.length < DRIFT_GAP_REGULARITY) return { hasCadence: false, reason: "drift_irregular_gaps", dupFrames: dupFrames, medianGap: medianGap };

    return { hasCadence: true, mode: "drift", dupFrames: dupFrames, medianGap: medianGap, confidence: "medium", analysis: analysis };
  }

  function scatteredClassExtremes(metrics, analysis) {
    var maxDup = null;
    var minMotion = null;
    for (var i = 0; i < metrics.length; i++) {
      if (isDuplicateMetric(metrics[i], analysis)) {
        if (maxDup === null || metrics[i].value > maxDup) maxDup = metrics[i].value;
      } else {
        if (minMotion === null || metrics[i].value < minMotion) minMotion = metrics[i].value;
      }
    }
    return { maxDup: maxDup, minMotion: minMotion };
  }

  function detectScatteredCadence(metrics, analysis) {
    var dupFrames = collectDuplicateFrames(metrics, analysis);
    if (dupFrames.length < SCATTER_MIN_DUPS) return { hasCadence: false, reason: "scatter_too_few_duplicates", dupFrames: dupFrames };
    if (dupFrames.length > SCATTER_MAX_FRACTION * metrics.length) return { hasCadence: false, reason: "scatter_too_many_duplicates", dupFrames: dupFrames };
    if (maxConsecutiveDuplicateRun(dupFrames) > DRIFT_MAX_RUN) return { hasCadence: false, reason: "scatter_duplicate_run", dupFrames: dupFrames };

    var extremes = scatteredClassExtremes(metrics, analysis);
    if (extremes.maxDup === null || extremes.minMotion === null || extremes.minMotion < SCATTER_GAP_RATIO * extremes.maxDup) {
      return { hasCadence: false, reason: "scatter_not_detached", dupFrames: dupFrames, extremes: extremes };
    }

    return { hasCadence: true, mode: "scattered", dupFrames: dupFrames, confidence: "medium", analysis: analysis };
  }

  function detectLockedCadence(metrics, maxPhases, periodOverride, analysis) {
    var periodResult;
    if (periodOverride) {
      periodResult = { hasPeriod: analysis.separable, period: periodOverride, score: null, analysis: analysis, reason: analysis.separable ? "" : "not_separable" };
    } else {
      periodResult = detectPeriodWithAnalysis(metrics, analysis);
    }

    if (!periodResult.hasPeriod) {
      return { hasCadence: false, reason: periodResult.reason, analysis: periodResult.analysis, periodResult: periodResult };
    }

    var phases = selectPhasesForPeriod(metrics, periodResult.period, periodResult.analysis, maxPhases);
    if (maxPhases && phases.length > maxPhases) {
      return { hasCadence: false, reason: "too_many_phases", analysis: periodResult.analysis, periodResult: periodResult, phases: phases };
    }
    if (residualDuplicateRate(metrics, periodResult.period, periodResult.analysis, phases) > MAX_RESIDUAL_DUP) {
      return { hasCadence: false, reason: "residual_duplicates", analysis: periodResult.analysis, periodResult: periodResult, phases: phases };
    }
    var sectionResult = crossSectionConfidence(metrics, periodResult.period, periodResult.analysis, phases, maxPhases);
    if (sectionResult.confidence === "none") {
      return { hasCadence: false, reason: "section_disagreement", analysis: periodResult.analysis, periodResult: periodResult, phases: phases };
    }

    return { hasCadence: true, mode: "locked", period: periodResult.period, phases: sectionResult.phases, confidence: sectionResult.confidence, score: periodResult.score, analysis: periodResult.analysis };
  }

  function addFreezes(result, freezes) {
    result.freezes = freezes;
    return result;
  }

  function detectCadence(metrics, maxPhases, periodOverride) {
    var analysis = analyzeDuplicateClass(metrics);
    if (!analysis.separable) {
      return { hasCadence: false, reason: "not_separable", analysis: analysis, freezes: [] };
    }

    var split = splitFreezeSpans(metrics, analysis);
    var workingDupFrames = collectDuplicateFrames(split.working, analysis);
    if (split.freezes.length && workingDupFrames.length < 2 * PERIOD_MIN) {
      return { hasCadence: false, reason: "freeze_only", analysis: analysis, freezes: split.freezes };
    }

    var lockedResult = detectLockedCadence(split.working, maxPhases, periodOverride, analysis);
    if (lockedResult.hasCadence || lockedResult.reason === "not_separable") return addFreezes(lockedResult, split.freezes);

    var driftResult = detectDriftCadence(split.working, lockedResult.analysis);
    if (driftResult.hasCadence) return addFreezes(driftResult, split.freezes);

    var scatterResult = detectScatteredCadence(split.working, lockedResult.analysis);
    if (scatterResult.hasCadence) return addFreezes(scatterResult, split.freezes);

    return addFreezes(lockedResult, split.freezes);
  }

  function phaseListContains(phases, phase) {
    for (var i = 0; i < phases.length; i++) {
      if (phases[i] === phase) return true;
    }
    return false;
  }

  function buildKeepFrames(frameCount, period, phases, srcStartFrame) {
    var keepFrames = [];
    var startFrame = srcStartFrame || 0;
    for (var frame = 0; frame < frameCount; frame++) {
      var sourcePhase = (((startFrame + frame) % period) + period) % period;
      if (!phaseListContains(phases, sourcePhase)) keepFrames.push(frame);
    }
    return keepFrames;
  }
  function buildKeepFramesFromDupList(frameCount, dupFrames, srcStartFrame) {
    var keepFrames = [];
    var startFrame = srcStartFrame || 0;
    var dupLookup = {};
    for (var i = 0; i < dupFrames.length; i++) dupLookup[dupFrames[i]] = true;
    for (var frame = 0; frame < frameCount; frame++) {
      if (!dupLookup[startFrame + frame]) keepFrames.push(frame);
    }
    return keepFrames;
  }
// === CORE END ===

  function fail(message) {
    alert(message, "Frame Plucker");
    var err = new Error(message);
    err.framePluckerHandled = true;
    throw err;
  }

  function lowerText(value) {
    return String(value).toLowerCase();
  }

  function isMac() {
    return lowerText($.os).match(/mac/) !== null;
  }

  function isWindows() {
    return lowerText($.os).match(/windows/) !== null;
  }

  function aeShellQuote(value) {
    return shellQuote(value, isWindows());
  }

  function getCachedFfmpegPath() {
    try {
      if (app.settings.haveSetting(SETTINGS_SECTION, SETTINGS_FFMPEG_PATH)) {
        return app.settings.getSetting(SETTINGS_SECTION, SETTINGS_FFMPEG_PATH);
      }
    } catch (err) {}
    return "";
  }

  function saveCachedFfmpegPath(path) {
    try {
      app.settings.saveSetting(SETTINGS_SECTION, SETTINGS_FFMPEG_PATH, String(path));
    } catch (err) {}
  }

  function clearCachedFfmpegPath() {
    try {
      app.settings.saveSetting(SETTINGS_SECTION, SETTINGS_FFMPEG_PATH, "");
    } catch (err) {}
  }

  function commandWorks(command) {
    try {
      var output = system.callSystem(aeShellQuote(command) + " -version");
      return lowerText(output).match(/ffmpeg version/) !== null;
    } catch (err) {
      return false;
    }
  }

  function scriptFolder() {
    try {
      if ($.fileName) return new File($.fileName).parent;
    } catch (err) {}
    return null;
  }

  function bundledLeafName() {
    return isWindows() ? "ffmpeg.exe" : "ffmpeg";
  }

  function bundledRelDir() {
    return isWindows() ? "win" : "mac";
  }

  function managedBinFolder() {
    return new Folder(Folder.userData.fsName + "/" + MANAGED_DIR_NAME + "/bin");
  }

  function managedFfmpegFile() {
    return new File(managedBinFolder().fsName + "/" + bundledLeafName());
  }

  function findBundledSourceFile(baseFolder) {
    if (!baseFolder) return null;
    try {
      var f = new File(baseFolder.fsName + "/bin/" + bundledRelDir() + "/" + bundledLeafName());
      if (f.exists) return f;
    } catch (err) {}
    return null;
  }

  function prepareMacBinary(file) {
    // Bundled binaries lose their executable bit through some zip/copy paths, and
    // a browser download tags them com.apple.quarantine, which Gatekeeper uses to
    // kill an unsigned exec launched from a shell. Fix both once, in place. These
    // calls emit almost no output, so they are not exposed to the callSystem
    // pipe-buffer freeze.
    if (!isMac()) return;
    var quoted = aeShellQuote(file.fsName);
    try { system.callSystem("/bin/chmod 755 " + quoted); } catch (err) {}
    try { system.callSystem("/usr/bin/xattr -d com.apple.quarantine " + quoted + " 2>/dev/null"); } catch (err2) {}
  }

  function provisionFromSource(srcFile) {
    // Copy the bundled binary into a user-writable managed dir (no admin needed),
    // fix mac perms/quarantine there, and verify it runs before trusting it.
    if (!srcFile || !srcFile.exists) return null;
    try {
      var destFolder = managedBinFolder();
      if (!destFolder.exists) {
        // Create the parent chain explicitly; Folder.create() is not reliably
        // recursive across ExtendScript versions.
        var parent = destFolder.parent;
        if (parent && !parent.exists) parent.create();
        destFolder.create();
        if (!destFolder.exists) return null;
      }
      var dest = managedFfmpegFile();
      if (!dest.exists) {
        if (!srcFile.copy(dest.fsName)) return null;
      }
      prepareMacBinary(dest);
      if (commandWorks(dest.fsName)) return dest.fsName;
    } catch (err) {}
    return null;
  }

  function resolveBundledFfmpeg(allowPrompt) {
    // 1. Already provisioned into the managed dir (fast path after first run).
    var managed = managedFfmpegFile();
    if (managed.exists && commandWorks(managed.fsName)) return managed.fsName;

    // 2. Bundled next to this script (folder-drop install or run-from-package).
    var fromScript = provisionFromSource(findBundledSourceFile(scriptFolder()));
    if (fromScript) return fromScript;

    // 3. As a last resort, ask the user once to point at the unzipped folder.
    if (allowPrompt) {
      var picked = Folder.selectDialog("Select the Frame Plucker folder you unzipped");
      if (picked) {
        var fromPicked = provisionFromSource(findBundledSourceFile(picked));
        if (fromPicked) return fromPicked;
      }
    }
    return null;
  }

  function findDefaultFfmpegPath() {
    // Respect an ffmpeg the user already has before falling back to our bundle.
    if (commandWorks("ffmpeg")) return "ffmpeg";

    var candidates = isMac()
      ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
      : (isWindows()
        ? ["C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"]
        : ["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);

    for (var i = 0; i < candidates.length; i++) {
      try {
        var candidate = new File(candidates[i]);
        if (candidate.exists && commandWorks(candidate.fsName)) return candidate.fsName;
      } catch (err) {}
    }

    // No user-supplied ffmpeg: fall back to the bundled binary (no prompt here;
    // the prompt-based recovery lives in analyzeSourceWithFfmpeg).
    var bundled = resolveBundledFfmpeg(false);
    if (bundled) return bundled;

    return "ffmpeg";
  }

  function isNotFoundOutput(output) {
    var text = lowerText(output);
    return text.match(/not found/) !== null ||
      text.match(/no such file/) !== null ||
      text.match(/not recognized/) !== null ||
      text.match(/cannot find/) !== null;
  }

  function isFileBackedSource(item) {
    return item && item instanceof FootageItem && item.file && item.file.exists && item.width > 0 && item.height > 0;
  }

  function sourceRefFromItem(item) {
    return { source: item, layer: null, comp: null, file: item.file, name: item.name, baseName: item.name, width: item.width, height: item.height, pixelAspect: item.pixelAspect || 1, bgColor: [0, 0, 0] };
  }

  function sourceRefFromLayer(layer, comp) {
    return { source: layer.source, layer: layer, comp: comp, file: layer.source.file, name: layer.name, baseName: comp.name, width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect || 1, bgColor: comp.bgColor };
  }

  function addSourceCandidate(candidates, refs, rule, id, ref) {
    candidates.push({ id: id, rule: rule }); refs.push(ref);
  }

  function collectSourceCandidates() {
    var candidates = [];
    var refs = [];
    var activeItem = app.project.activeItem;
    var selection = app.project.selection || [];

    for (var selectedIndex = 0; selectedIndex < selection.length; selectedIndex++) {
      if (isFileBackedSource(selection[selectedIndex])) {
        addSourceCandidate(candidates, refs, 1, String(selection[selectedIndex].id), sourceRefFromItem(selection[selectedIndex]));
      }
    }

    if (activeItem instanceof CompItem) {
      var selectedLayers = activeItem.selectedLayers || [];
      for (var layerIndex = 0; layerIndex < selectedLayers.length; layerIndex++) {
        var layer = selectedLayers[layerIndex];
        if (layer instanceof AVLayer && isFileBackedSource(layer.source)) {
          addSourceCandidate(candidates, refs, 2, String(layer.source.id) + ":" + layer.index, sourceRefFromLayer(layer, activeItem));
        }
      }
    }

    if (isFileBackedSource(activeItem)) {
      addSourceCandidate(candidates, refs, 3, String(activeItem.id), sourceRefFromItem(activeItem));
    }

    var onlyFileBacked = null;
    var fileBackedCount = 0;
    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex++) {
      var item = app.project.item(itemIndex);
      if (isFileBackedSource(item)) {
        onlyFileBacked = item;
        fileBackedCount++;
      }
    }
    if (fileBackedCount === 1) {
      addSourceCandidate(candidates, refs, 4, String(onlyFileBacked.id), sourceRefFromItem(onlyFileBacked));
    }

    return { candidates: candidates, refs: refs };
  }

  function resolveSourceRef() {
    var collected = collectSourceCandidates();
    var resolved = resolveSourceSelection(collected.candidates);
    if (resolved.error === "multiple") fail("Multiple videos selected - select a single video (or one layer) and run again.");
    if (resolved.error === "none") fail("Select the footage to clean in the Project panel, or select its layer in a comp, then run again.");
    return collected.refs[resolved.index];
  }

  function validateSourceRef(sourceRef) {
    if (sourceRef.layer) {
      if (Math.abs(sourceRef.layer.stretch - 100) > 0.01 || sourceRef.layer.timeRemapEnabled) fail("Stretched or time-remapped layers are not supported. Select the footage item in the Project panel instead.");
    }
  }

  function getSourceFrameRate(sourceRef) {
    if (sourceRef.layer && sourceRef.comp) return sourceRef.comp.frameRate;
    return sourceRef.source ? sourceRef.source.frameRate : 0;
  }

  function getProbeFrameCount(sourceRef, fps) {
    var duration = sourceRef.source && sourceRef.source.duration ? sourceRef.source.duration : 0;
    var count = Math.round(duration * fps);
    if (!isFinite(count) || count < 2) {
      fail("Could not determine a usable source duration.");
    }
    return Math.min(count, HARD_CAP);
  }

  function getVisibleFrameCount(sourceRef, fps) {
    var duration = sourceRef.source && sourceRef.source.duration ? sourceRef.source.duration : 0;
    if (sourceRef.layer) duration = Math.max(0, sourceRef.layer.outPoint - sourceRef.layer.inPoint);

    var count = Math.round(duration * fps);
    if (!isFinite(count) || count < 2) {
      fail("Could not determine a usable visible duration.");
    }
    return count;
  }

  function makeTempFile(tag) {
    var stamp = (new Date()).getTime();
    return new File(Folder.temp.fsName + "/fp_" + tag + "_" + stamp + ".txt");
  }

  function readAndRemove(tmpFile) {
    var text = "";
    try {
      if (tmpFile.exists && tmpFile.open("r")) {
        text = tmpFile.read();
        tmpFile.close();
      }
    } catch (err) {}
    try { if (tmpFile.exists) tmpFile.remove(); } catch (err2) {}
    return String(text);
  }

  function runFfmpegDiffProbe(file, ffmpegPath, frameLimit) {
    var metricsFile = makeTempFile("metrics");
    var errFile = makeTempFile("err");
    var filter = "select=lt(n\\," + frameLimit + "),scale=160:-1,tblend=all_mode=difference,signalstats,metadata=print:file=-:key=lavfi.signalstats.YAVG";
    // Redirect ffmpeg's stdout (metadata) and stderr to temp files at the shell
    // level instead of capturing a large stdout pipe. AE's blocking
    // system.callSystem() can deadlock/freeze when the child fills the OS pipe
    // buffer faster than AE drains it, and a full-clip probe emits up to
    // HARD_CAP metadata lines. The filter chain is unchanged (file=- keeps the
    // Windows-path colon out of the filtergraph), so fixtures stay valid.
    var command = aeShellQuote(ffmpegPath) +
      " -hide_banner -v error -i " + aeShellQuote(file.fsName) +
      " -vf " + aeShellQuote(filter) +
      " -frames:v " + frameLimit +
      " -an -f null -" +
      " 1>" + aeShellQuote(metricsFile.fsName) +
      " 2>" + aeShellQuote(errFile.fsName);

    system.callSystem(command);

    var metricsText = readAndRemove(metricsFile);
    var errText = readAndRemove(errFile);
    // parseDiffMetrics reads the metadata lines; isNotFoundOutput and the
    // failure messages read ffmpeg's stderr. Returning both keeps every caller
    // working against a single string, as before.
    return metricsText + "\n" + errText;
  }

  function getOriginalSourceTime(sourceRef, frameIndex, fps) {
    if (sourceRef.layer) {
      var compTime = sourceRef.layer.inPoint + frameIndex / fps;
      try {
        return sourceRef.layer.sourceTime(compTime);
      } catch (err) {
        return (sourceRef.layer.inPoint - sourceRef.layer.startTime) + frameIndex / fps;
      }
    }
    return frameIndex / fps;
  }

  function setHoldKeys(property) {
    for (var keyIndex = 1; keyIndex <= property.numKeys; keyIndex++) {
      property.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    }
  }

  function uniqueCompName(baseName) {
    var name = baseName;
    var suffix = 2;
    var exists = true;

    while (exists) {
      exists = false;
      for (var i = 1; i <= app.project.numItems; i++) {
        if (app.project.item(i).name === name) {
          exists = true;
          name = baseName + " " + suffix;
          suffix++;
          break;
        }
      }
    }

    return name;
  }

  function phasesToText(phases) {
    var parts = [];
    for (var i = 0; i < phases.length; i++) parts.push(String(phases[i]));
    return parts.join(",");
  }

  function formatEffectiveFps(fps, period, removedPerPeriod) {
    var value = fps * (period - removedPerPeriod) / period;
    return String(Math.round(value * 100) / 100);
  }

  function removalPercent(removed, total) {
    return total ? Math.round(removed / total * 100) : 0;
  }

  function freezeMarkerSuffix(detection) {
    var text = "";
    if (!detection.freezes) return text;
    for (var i = 0; i < detection.freezes.length; i++) {
      text += "; freeze " + detection.freezes[i].start + "+" + detection.freezes[i].length;
    }
    return text;
  }

  function freezeAlertLines(detection) {
    var text = "";
    if (!detection.freezes) return text;
    for (var i = 0; i < detection.freezes.length; i++) {
      text += "Kept: " + detection.freezes[i].length + "-frame freeze at frame " + detection.freezes[i].start + "\n";
    }
    return text;
  }

  function makeDetectionSummary(name, fps, detection, removed, frameCount) {
    var freezeSuffix = freezeMarkerSuffix(detection);
    if (detection.mode === "drift") {
      return "Created " + name + ". Detected a drifting hold cadence: removed " + removed + " duplicate frames (~1 every " + detection.medianGap + "). Confidence: " + detection.confidence + "." + freezeSuffix;
    }
    if (detection.mode === "scattered") {
      return "Created " + name + ". Removed " + removed + " isolated held frame(s); no repeating cadence in the rest of the clip. Confidence: " + detection.confidence + "." + freezeSuffix;
    }
    return "Created " + name + ". Detected " + detection.phases.length + " duplicate frame(s) every " + detection.period + " - the clip is effectively " + formatEffectiveFps(fps, detection.period, detection.phases.length) + " fps content. Removed " + removed + " of " + frameCount + " frames. Confidence: " + detection.confidence + ". Phases: " + phasesToText(detection.phases) + "." + freezeSuffix;
  }

  function makeResultAlertMessage(name, fps, detection, removed, frameCount) {
    var pct = removalPercent(removed, frameCount);
    var freezeLines = freezeAlertLines(detection);
    if (detection.mode === "drift") {
      return "Clean comp created:\n" + name + "\n\n" +
        "Cadence: drifting hold, about 1 duplicate every " + detection.medianGap + " frames\n" +
        "Removed: " + removed + " of " + frameCount + " frames (" + pct + "%)\n" +
        freezeLines +
        "Confidence: medium";
    }
    if (detection.mode === "scattered") {
      return "Clean comp created:\n" + name + "\n\n" +
        "Found " + detection.dupFrames.length + " isolated held frame(s); no repeating cadence elsewhere.\n" +
        "Removed: " + removed + " of " + frameCount + " frames (" + pct + "%)\n" +
        freezeLines +
        "Confidence: medium";
    }
    return "Clean comp created:\n" + name + "\n\n" +
      "Cadence: 1 duplicate every " + detection.period + " frames on phase(s) " + phasesToText(detection.phases) + "\n" +
      "Removed: " + removed + " of " + frameCount + " frames (" + pct + "%)\n" +
      "Content rate: ~" + formatEffectiveFps(fps, detection.period, detection.phases.length) + " fps inside a " + fps + " fps clip\n" +
      freezeLines +
      "Confidence: " + detection.confidence;
  }

  function makeMediumConfidencePrompt(detection, frameCount) {
    if (detection.mode === "drift") {
      return "Found a drifting hold cadence.\n\n" +
        "About 1 duplicate every " + detection.medianGap + " frames\n" +
        detection.dupFrames.length + " duplicates across " + frameCount + " frames\n" +
        "Confidence: MEDIUM\n\n" +
        "Create the clean comp?";
    }
    if (detection.mode === "scattered") {
      return "No repeating cadence, but " + detection.dupFrames.length +
        " isolated held frame(s) were found\n" +
        "(first at frame " + detection.dupFrames[0] + ").\n\n" +
        "Remove just those frames?";
    }
    return "Cadence found, but sections of the clip disagree (or the clip is short).\n\n" +
      "Pattern: 1 duplicate every " + detection.period + " frames on phase(s) " + phasesToText(detection.phases) + "\n" +
      "Confidence: MEDIUM\n\n" +
      "Create the clean comp?";
  }

  function makeNoCadenceAlertMessage(fps, detection) {
    var message = "No duplicate-frame cadence found.\n\n";
    if (detection.reason === "freeze_only") {
      message += "The clip's duplicates form freeze holds, not a stutter cadence.\n\n";
    }
    return message + "This clip plays like genuine " + fps + " fps motion - nothing to remove.";
  }

  function getRunFfmpegPath() {
    // PATH always wins, on every run and on both Mac and Windows: a pro user's
    // own ffmpeg is never shadowed by a cached bundle, and if they install
    // ffmpeg later we pick it up automatically. This probe is at pluck time, not
    // script load, so the panel still opens instantly. Users with no ffmpeg on
    // PATH fall through to the cached/common/bundled resolution below.
    if (commandWorks("ffmpeg")) return "ffmpeg";
    var cached = getCachedFfmpegPath();
    if (cached && commandWorks(cached)) return cached;
    return findDefaultFfmpegPath();
  }

  function makeFfmpegFailureMessage(output, includeDownload) {
    var message = "ffmpeg could not analyze this clip.\n\nffmpeg said:\n" + lastNonEmptyLines(output, 4);
    return includeDownload ? message + "\n\nDownload ffmpeg: ffmpeg.org/download.html" : message;
  }

  function analyzeSourceWithFfmpeg(sourceRef, frameLimit) {
    var ffmpegPath = getRunFfmpegPath();
    var output = runFfmpegDiffProbe(sourceRef.file, ffmpegPath, frameLimit);
    var metrics = parseDiffMetrics(output);
    if (metrics.length >= 12) {
      saveCachedFfmpegPath(ffmpegPath);
      return { metrics: metrics };
    }

    if (isNotFoundOutput(output)) {
      clearCachedFfmpegPath();
      // Try the bundled engine first (may prompt once for the unzipped folder),
      // so users without ffmpeg never need to hunt for an executable.
      var bundledPath = resolveBundledFfmpeg(true);
      if (bundledPath) {
        var bundledOutput = runFfmpegDiffProbe(sourceRef.file, bundledPath, frameLimit);
        var bundledMetrics = parseDiffMetrics(bundledOutput);
        if (bundledMetrics.length >= 12) {
          saveCachedFfmpegPath(bundledPath);
          return { metrics: bundledMetrics };
        }
      }
      var file = File.openDialog("Locate the ffmpeg executable");
      if (file) {
        var retryPath = file.fsName;
        var retryOutput = runFfmpegDiffProbe(sourceRef.file, retryPath, frameLimit);
        var retryMetrics = parseDiffMetrics(retryOutput);
        if (retryMetrics.length >= 12) {
          saveCachedFfmpegPath(retryPath);
          return { metrics: retryMetrics };
        }
        fail(makeFfmpegFailureMessage(retryOutput, true));
      }
      fail(makeFfmpegFailureMessage(output, true));
    }

    fail(makeFfmpegFailureMessage(output, false));
  }

  function collectDebugMarks(detection, metrics) {
    // Source frames the pluck would remove. When no cadence was found, fall back
    // to the raw duplicate candidates so a false negative is still inspectable.
    var frames = [];
    var i, phase;
    if (detection.hasCadence && detection.mode === "locked") {
      for (i = 0; i < metrics.length; i++) {
        phase = ((metrics[i].frame % detection.period) + detection.period) % detection.period;
        if (phaseListContains(detection.phases, phase)) frames.push(metrics[i].frame);
      }
    } else if (detection.hasCadence) {
      for (i = 0; i < detection.dupFrames.length; i++) frames.push(detection.dupFrames[i]);
    } else if (detection.analysis) {
      for (i = 0; i < metrics.length; i++) {
        if (metrics[i].value <= detection.analysis.cutoff) frames.push(metrics[i].frame);
      }
    }
    return frames;
  }

  function buildDebugComp(sourceRef, fps, frameCount, frames) {
    var name = uniqueCompName(sourceRef.baseName + "_ffmpeg_DEBUG_marks");
    var comp = app.project.items.addComp(name, sourceRef.width, sourceRef.height, sourceRef.pixelAspect, frameCount / fps, fps);
    comp.bgColor = sourceRef.bgColor;
    var layer = comp.layers.add(sourceRef.source);
    layer.name = sourceRef.name + " (debug: nothing removed)";
    layer.startTime = 0;
    layer.audioEnabled = false;
    var markerProp = layer.property("Marker");
    for (var i = 0; i < frames.length; i++) {
      markerProp.setValueAtTime(frames[i] / fps, new MarkerValue(""));
    }
    comp.openInViewer();
    return name;
  }

  function makeDebugMessage(detection, marks, name) {
    var head = "DEBUG - nothing removed.\n\nMarked " + marks.length + " frame(s) on:\n" + name + "\n\n";
    if (detection.hasCadence) {
      if (detection.mode === "locked") {
        return head + "Would remove phase(s) " + phasesToText(detection.phases) + " every " + detection.period +
          " frames.\nStep through and confirm each marked frame is a held frame.";
      }
      if (detection.mode === "drift") {
        return head + "Would remove a drifting hold (~1 every " + detection.medianGap + " frames).";
      }
      return head + "Would remove " + (detection.dupFrames ? detection.dupFrames.length : marks.length) + " isolated held frame(s).";
    }
    return head + "No cadence (" + (detection.reason || "unknown") + "). Marks show the raw duplicate candidates the metric found.";
  }

  function runPluck(debug) {
    var sourceRef = resolveSourceRef();
    validateSourceRef(sourceRef);
    var fps = getSourceFrameRate(sourceRef);
    if (!isFinite(fps) || fps <= 0) fail("Could not determine a positive source frame rate.");

    var probeFrameCount = getProbeFrameCount(sourceRef, fps);
    writeLn("Frame Plucker: analyzing " + sourceRef.name + " (" + probeFrameCount + " frames)...");
    var analysisResult = analyzeSourceWithFfmpeg(sourceRef, probeFrameCount);
    writeLn("Frame Plucker: analysis done.");

    var metrics = analysisResult.metrics;

    var detection = detectCadence(metrics, MAX_PHASES, 0);

    if (debug) {
      // Mark what would be removed on a full-length copy of the source; remove
      // nothing. Short-circuits confirms and comp creation so any detection
      // (including "no cadence") is inspectable frame by frame.
      var marks = collectDebugMarks(detection, metrics);
      app.beginUndoGroup("Frame Plucker Debug");
      var debugName;
      try {
        debugName = buildDebugComp(sourceRef, fps, probeFrameCount, marks);
      } finally {
        app.endUndoGroup();
      }
      alert(makeDebugMessage(detection, marks, debugName), "Frame Plucker");
      return;
    }

    if (!detection.hasCadence) {
      if (detection.reason === "too_many_phases") {
        var tooManyPhasesMessage = "Found " + detection.phases.length + " duplicate phases per " + detection.periodResult.period + "-frame period - more than this\n" +
          "tool will remove automatically.\n\n" +
          "This may not be a cadence that is safe to clean.";
        alert(tooManyPhasesMessage, "Frame Plucker");
        return;
      }
      alert(makeNoCadenceAlertMessage(fps, detection), "Frame Plucker");
      return;
    }

    var visibleFrameCount = getVisibleFrameCount(sourceRef, fps);
    var srcStartFrame = Math.round(getOriginalSourceTime(sourceRef, 0, fps) * fps);

    if (detection.confidence === "medium") {
      var proceed = confirm(makeMediumConfidencePrompt(detection, visibleFrameCount), false, "Frame Plucker");
      if (!proceed) return;
    }

    if (detection.mode !== "locked") {
      // tblend emits one fewer metric than source frames; the final diff metric covers the next source frame.
      var lastAnalyzedSourceFrame = metrics[metrics.length - 1].frame + 1;
      if (srcStartFrame + visibleFrameCount - 1 > lastAnalyzedSourceFrame) {
        fail("Clip is longer than the analyzed range; per-frame cleanup needs the whole clip analyzed. Trim the layer or raise the analysis cap.");
      }
    }
    var keepFrames = detection.mode === "locked"
      ? buildKeepFrames(visibleFrameCount, detection.period, detection.phases, srcStartFrame)
      : buildKeepFramesFromDupList(visibleFrameCount, detection.dupFrames, srcStartFrame);
    if (keepFrames.length < 2) fail("Detected cadence removes too many frames.");

    app.beginUndoGroup("Frame Plucker");
    try {
      var cleanDuration = keepFrames.length / fps;
      var cleanNameBase;
      if (detection.mode === "drift") {
        cleanNameBase = sourceRef.baseName + "_ffmpeg_clean_driftg" + detection.medianGap;
      } else if (detection.mode === "scattered") {
        cleanNameBase = sourceRef.baseName + "_ffmpeg_clean_pluck" + detection.dupFrames.length;
      } else {
        var phaseLabel = phasesToText(detection.phases).replace(/,/g, "-");
        cleanNameBase = sourceRef.baseName + "_ffmpeg_clean_p" + detection.period + "_phase" + phaseLabel;
      }
      var cleanName = uniqueCompName(cleanNameBase);
      var cleanComp = app.project.items.addComp(
        cleanName,
        sourceRef.width,
        sourceRef.height,
        sourceRef.pixelAspect,
        cleanDuration,
        fps
      );
      cleanComp.bgColor = sourceRef.bgColor;

      var cleanLayer = cleanComp.layers.add(sourceRef.source);
      cleanLayer.name = sourceRef.name + " ffmpeg cadence clean";
      cleanLayer.startTime = 0;
      cleanLayer.inPoint = 0;
      cleanLayer.outPoint = cleanDuration;
      cleanLayer.audioEnabled = false;
      cleanLayer.timeRemapEnabled = true;

      var remap = cleanLayer.property("ADBE Time Remapping");
      for (var i = 0; i < keepFrames.length; i++) {
        remap.setValueAtTime(i / fps, getOriginalSourceTime(sourceRef, keepFrames[i], fps));
      }
      remap.setValueAtTime(cleanDuration, getOriginalSourceTime(sourceRef, keepFrames[keepFrames.length - 1], fps));
      setHoldKeys(remap);

      var removedFrameCount = visibleFrameCount - keepFrames.length;
      var summary = makeDetectionSummary(cleanName, fps, detection, removedFrameCount, visibleFrameCount);
      var resultMessage = makeResultAlertMessage(cleanName, fps, detection, removedFrameCount, visibleFrameCount);
      var marker = new MarkerValue(summary);
      cleanComp.markerProperty.setValueAtTime(0, marker);
      cleanComp.openInViewer();
    } finally {
      app.endUndoGroup();
    }

    alert(resultMessage, "Frame Plucker");
  }

  function buildPanel(rootObj) {
    var panel = (rootObj instanceof Panel)
      ? rootObj
      : new Window("palette", "Frame Plucker", undefined, { resizeable: true });

    panel.orientation = "column";
    panel.alignChildren = ["fill", "top"];
    panel.spacing = 8;
    panel.margins = 12;

    var hint = panel.add("statictext", undefined,
      "Select a video in the Project panel (or its layer in a comp), then pluck.",
      { multiline: true });
    hint.preferredSize.height = 34;

    var pluckButton = panel.add("button", undefined, "Pluck Frames");
    var debugCheck = panel.add("checkbox", undefined, "Debug: mark frames, don't remove");
    debugCheck.helpTip = "Build a comp of the untouched source with a marker on every frame that would be removed, so you can step through and check each one.";
    pluckButton.onClick = function () {
      pluckButton.enabled = false;
      try {
        runPluck(debugCheck.value);
      } catch (err) {
        // fail() already alerted before throwing; only surface unexpected errors.
        if (!(err && err.framePluckerHandled)) {
          alert("Something went wrong:\n" + ((err && err.message) ? err.message : String(err)), "Frame Plucker");
        }
      } finally {
        pluckButton.enabled = true;
      }
    };

    panel.layout.layout(true);
    return panel;
  }

  var ui = buildPanel(thisObj);
  if (ui instanceof Window) {
    ui.center();
    ui.show();
  }
}(this));
