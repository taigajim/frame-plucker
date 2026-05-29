// Frame Plucker
// Uses ffmpeg only
// 1. Select/import a file-backed video in AE.
// 2. Run this script.
// 3. The script asks ffmpeg to measure adjacent-frame differences from the

(function () {
  var DEFAULT_FPS = 24;
  var DEFAULT_PERIOD = 24;
  var DEFAULT_SCAN_FRAMES = 100;
  var DEFAULT_SEARCH_FRAMES = 240;
  var DEFAULT_MAX_PHASES = 6;
  var DEFAULT_FFMPEG = findDefaultFfmpegPath();

  function fail(message) {
    alert(message);
    throw new Error(message);
  }

  function isMac() {
    return String($.os).toLowerCase().indexOf("mac") >= 0;
  }

  function isWindows() {
    return String($.os).toLowerCase().indexOf("windows") >= 0;
  }

  function findDefaultFfmpegPath() {
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

    return "ffmpeg";
  }

  function commandWorks(command) {
    try {
      var output = system.callSystem(shellQuote(command) + " -version");
      return String(output).toLowerCase().indexOf("ffmpeg version") >= 0;
    } catch (err) {
      return false;
    }
  }

  function shellQuote(value) {
    var text = String(value);
    if (isWindows()) {
      return "\"" + text.replace(/"/g, "\\\"") + "\"";
    }
    return "\"" + text.replace(/(["\\$`])/g, "\\$1") + "\"";
  }

  function isFileBackedSource(item) {
    return item && item instanceof FootageItem && item.file && item.file.exists && item.width > 0 && item.height > 0;
  }

  function sourceRefFromItem(item, priority) {
    return {
      source: item,
      layer: null,
      comp: null,
      file: item.file,
      name: item.name,
      baseName: item.name,
      width: item.width,
      height: item.height,
      pixelAspect: item.pixelAspect || 1,
      bgColor: [0, 0, 0],
      priority: priority || 0,
      label: "Project: " + item.name
    };
  }

  function sourceRefFromLayer(layer, comp, priority) {
    return {
      source: layer.source,
      layer: layer,
      comp: comp,
      file: layer.source.file,
      name: layer.name,
      baseName: comp.name,
      width: comp.width,
      height: comp.height,
      pixelAspect: comp.pixelAspect || 1,
      bgColor: comp.bgColor,
      priority: priority || 0,
      label: "Layer: " + layer.name
    };
  }

  function collectSourceRefs() {
    var refs = [];
    var activeItem = app.project.activeItem;
    var selection = app.project.selection || [];

    if (activeItem instanceof CompItem) {
      for (var layerIndex = 1; layerIndex <= activeItem.numLayers; layerIndex++) {
        var layer = activeItem.layer(layerIndex);
        if (layer instanceof AVLayer && isFileBackedSource(layer.source)) {
          refs.push(sourceRefFromLayer(layer, activeItem, 100));
        }
      }
    }

    for (var selectedIndex = 0; selectedIndex < selection.length; selectedIndex++) {
      if (isFileBackedSource(selection[selectedIndex])) {
        refs.push(sourceRefFromItem(selection[selectedIndex], 90));
      }
    }

    if (isFileBackedSource(activeItem)) {
      refs.push(sourceRefFromItem(activeItem, 80));
    }

    for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex++) {
      var item = app.project.item(itemIndex);
      if (isFileBackedSource(item)) {
        refs.push(sourceRefFromItem(item, 0));
      }
    }

    refs.sort(function (a, b) {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1;
    });

    return refs;
  }

  function chooseSettings() {
    var refs = collectSourceRefs();
    if (refs.length < 1) {
      fail("Import a file-backed video or open a comp containing one before running this script.");
    }

    var FORM_WIDTH = 420;
    var FIELD_WIDTH = 76;

    function addSettingColumn(parent, label, value) {
      var column = parent.add("group");
      column.orientation = "column";
      column.alignChildren = ["fill", "top"];
      column.add("statictext", undefined, label);
      var input = column.add("edittext", undefined, String(value));
      input.preferredSize.width = FIELD_WIDTH;
      return input;
    }

    var dialog = new Window("dialog", "Frame Plucker");
    dialog.orientation = "column";
    dialog.alignChildren = ["fill", "top"];

    var sourceGroup = dialog.add("group");
    sourceGroup.orientation = "column";
    sourceGroup.alignChildren = ["fill", "top"];
    sourceGroup.add("statictext", undefined, "Source");
    var sourceDropdown = sourceGroup.add("dropdownlist", undefined, []);
    for (var i = 0; i < refs.length; i++) sourceDropdown.add("item", refs[i].label);
    sourceDropdown.selection = 0;
    sourceDropdown.preferredSize.width = FORM_WIDTH;

    var ffmpegGroup = dialog.add("group");
    ffmpegGroup.orientation = "column";
    ffmpegGroup.alignChildren = ["fill", "top"];
    ffmpegGroup.add("statictext", undefined, "ffmpeg");
    var ffmpegRow = ffmpegGroup.add("group");
    ffmpegRow.orientation = "row";
    ffmpegRow.alignChildren = ["left", "center"];
    var ffmpegInput = ffmpegRow.add("edittext", undefined, DEFAULT_FFMPEG);
    ffmpegInput.preferredSize.width = 316;
    var browseButton = ffmpegRow.add("button", undefined, "Browse");
    browseButton.preferredSize.width = 96;
    browseButton.onClick = function () {
      var file = File.openDialog("Choose ffmpeg executable");
      if (file) ffmpegInput.text = file.fsName;
    };

    var settingsGroup = dialog.add("group");
    settingsGroup.orientation = "row";
    settingsGroup.alignChildren = ["left", "top"];
    settingsGroup.spacing = 10;
    var fpsInput = addSettingColumn(settingsGroup, "FPS", DEFAULT_FPS);
    var periodInput = addSettingColumn(settingsGroup, "Period", DEFAULT_PERIOD);
    var scanInput = addSettingColumn(settingsGroup, "Window", DEFAULT_SCAN_FRAMES);
    var searchInput = addSettingColumn(settingsGroup, "Search", DEFAULT_SEARCH_FRAMES);
    var maxPhasesInput = addSettingColumn(settingsGroup, "Max phases", DEFAULT_MAX_PHASES);

    var buttons = dialog.add("group");
    buttons.alignment = ["right", "top"];
    buttons.add("button", undefined, "Cancel", { name: "cancel" });
    buttons.add("button", undefined, "Pluck", { name: "ok" });

    if (dialog.show() !== 1) return null;

    var fps = parseFloat(fpsInput.text);
    var period = parseInt(periodInput.text, 10);
    var scanFrames = parseInt(scanInput.text, 10);
    var searchFrames = parseInt(searchInput.text, 10);
    var maxPhases = parseInt(maxPhasesInput.text, 10);
    if (!isFinite(fps) || fps <= 0) fail("FPS must be a positive number.");
    if (!isFinite(period) || period < 2) fail("Period must be 2 or higher.");
    if (!isFinite(scanFrames) || scanFrames < period * 2) fail("Window must be at least two periods.");
    if (!isFinite(searchFrames) || searchFrames < scanFrames) fail("Search must be at least the window length.");
    if (!isFinite(maxPhases) || maxPhases < 1 || maxPhases > period) fail("Max phases must be between 1 and period.");

    return {
      sourceRef: refs[sourceDropdown.selection.index],
      ffmpegPath: ffmpegInput.text,
      fps: fps,
      period: period,
      scanFrames: scanFrames,
      searchFrames: searchFrames,
      maxPhases: maxPhases
    };
  }

  function runFfmpegDiffProbe(file, ffmpegPath, searchFrames) {
    var filter = "select=lt(n\\," + searchFrames + "),scale=160:-1,tblend=all_mode=difference,signalstats,metadata=print:file=-:key=lavfi.signalstats.YAVG";
    var command = shellQuote(ffmpegPath) +
      " -hide_banner -v error -i " + shellQuote(file.fsName) +
      " -vf " + shellQuote(filter) +
      " -an -f null - 2>&1";

    return system.callSystem(command);
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
        metrics.push({
          frame: currentFrame,
          value: parseFloat(valueMatch[1])
        });
        currentFrame = null;
      }
    }

    return metrics;
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

  function findLowThreshold(values) {
    var sorted = values.slice(0).sort(function (a, b) { return a - b; });
    var maxIndex = Math.max(1, Math.floor(sorted.length * 0.5));
    var bestIndex = 0;
    var bestGap = 0;

    for (var i = 0; i < maxIndex && i < sorted.length - 1; i++) {
      var gap = sorted[i + 1] - sorted[i];
      if (gap > bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }

    if (bestGap > 0.000001) return sorted[bestIndex];
    return percentile(values, 0.1);
  }

  function addUniquePhase(values, phase) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] === phase) return;
    }
    values.push(phase);
  }

  function sliceMetrics(metrics, startFrame, endFrame) {
    var sliced = [];
    for (var i = 0; i < metrics.length; i++) {
      if (metrics[i].frame >= startFrame && metrics[i].frame < endFrame) {
        sliced.push(metrics[i]);
      }
    }
    return sliced;
  }

  function getMetricValues(metrics) {
    var values = [];
    for (var i = 0; i < metrics.length; i++) values.push(metrics[i].value);
    return values;
  }

  function scoreMetricWindow(metrics) {
    if (metrics.length < 2) return -1;

    var values = getMetricValues(metrics);
    var p10 = percentile(values, 0.1);
    var p50 = percentile(values, 0.5);
    var p90 = percentile(values, 0.9);
    var spread = p90 - p10;
    var nearFlat = 0;

    for (var i = 0; i < values.length; i++) {
      if (values[i] <= 0.01) nearFlat++;
    }

    var flatRatio = nearFlat / values.length;
    if (spread < 0.03 || p90 < 0.05 || flatRatio > 0.35) return -1;

    return spread + p50 * 0.05;
  }

  function chooseDetectionWindow(metrics, period, scanFrames) {
    if (metrics.length < period * 2 - 1) {
      fail("ffmpeg returned too few frame metrics. Check the source and ffmpeg path.");
    }

    var windowMetricsTarget = Math.max(period * 2 - 1, scanFrames - 1);
    if (metrics.length <= windowMetricsTarget) return metrics;

    var best = null;
    var step = Math.max(1, Math.floor(period / 2));
    var latestStart = metrics[metrics.length - windowMetricsTarget].frame;

    for (var start = 0; start <= latestStart; start += step) {
      var windowMetrics = sliceMetrics(metrics, start, start + windowMetricsTarget);
      if (windowMetrics.length < windowMetricsTarget) continue;

      var score = scoreMetricWindow(windowMetrics);
      if (!best || score > best.score) {
        best = {
          metrics: windowMetrics,
          score: score
        };
      }
    }

    if (!best || best.score < 0) {
      fail("The scanned section is too static for reliable auto-detection. Increase Search or mark phases manually.");
    }

    return best.metrics;
  }

  function detectPhases(metrics, period, maxPhases, scanFrames) {
    var windowMetrics = chooseDetectionWindow(metrics, period, scanFrames);
    var values = getMetricValues(windowMetrics);
    var lowThreshold = findLowThreshold(values);
    var groups = [];

    for (var phase = 0; phase < period; phase++) {
      var phaseValues = [];
      var lowFrames = [];

      for (var metricIndex = 0; metricIndex < windowMetrics.length; metricIndex++) {
        var metric = windowMetrics[metricIndex];
        var metricPhase = ((metric.frame % period) + period) % period;
        if (metricPhase !== phase) continue;

        phaseValues.push(metric.value);
        if (metric.value <= lowThreshold) lowFrames.push(metric.frame);
      }

      if (phaseValues.length) {
        groups.push({
          phase: phase,
          median: median(phaseValues),
          hitRate: lowFrames.length / phaseValues.length,
          lowCount: lowFrames.length,
          lowFrames: lowFrames
        });
      }
    }

    groups.sort(function (a, b) {
      if (a.lowCount !== b.lowCount) return b.lowCount - a.lowCount;
      if (a.hitRate !== b.hitRate) return b.hitRate - a.hitRate;
      if (a.median !== b.median) return a.median - b.median;
      return a.phase - b.phase;
    });

    var selected = [];
    var candidateCount = 0;
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      if (groups[groupIndex].lowCount >= 2 && groups[groupIndex].hitRate >= 0.5) {
        candidateCount++;
        if (selected.length < maxPhases) addUniquePhase(selected, groups[groupIndex].phase);
      }
    }

    if (selected.length < 1) {
      fail("No repeated low-motion phase was detected. This clip may not have a stable cadence in the first scanned frames.");
    }

    selected.sort(function (a, b) { return a - b; });

    var averageHitRate = 0;
    var selectedGroups = 0;
    for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
      for (var findIndex = 0; findIndex < groups.length; findIndex++) {
        if (groups[findIndex].phase === selected[selectedIndex]) {
          averageHitRate += groups[findIndex].hitRate;
          selectedGroups++;
          break;
        }
      }
    }
    averageHitRate = selectedGroups ? averageHitRate / selectedGroups : 0;

    return {
      phases: selected,
      threshold: lowThreshold,
      windowStart: windowMetrics[0].frame,
      windowEnd: windowMetrics[windowMetrics.length - 1].frame + 1,
      confidence: candidateCount > maxPhases ? "review" : (averageHitRate >= 0.85 ? "high" : (averageHitRate >= 0.6 ? "medium" : "review"))
    };
  }

  function phaseListContains(phases, phase) {
    for (var i = 0; i < phases.length; i++) {
      if (phases[i] === phase) return true;
    }
    return false;
  }

  function getSourceFrameCount(sourceRef, fps) {
    var duration = sourceRef.source && sourceRef.source.duration ? sourceRef.source.duration : 0;
    if (sourceRef.layer) duration = Math.max(0, sourceRef.layer.outPoint - sourceRef.layer.inPoint);

    var count = Math.round(duration * fps);
    if (!isFinite(count) || count < 2) {
      fail("Could not determine a usable source duration. Check the selected source and FPS.");
    }
    return count;
  }

  function buildKeepFrames(frameCount, period, phases) {
    var keepFrames = [];
    for (var frame = 0; frame < frameCount; frame++) {
      if (!phaseListContains(phases, frame % period)) keepFrames.push(frame);
    }
    return keepFrames;
  }

  function setHoldKeys(property) {
    for (var keyIndex = 1; keyIndex <= property.numKeys; keyIndex++) {
      property.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    }
  }

  function getOriginalSourceTime(sourceRef, frameIndex, fps) {
    if (sourceRef.layer) {
      var compTime = sourceRef.layer.startTime + frameIndex / fps;
      try {
        return sourceRef.layer.sourceTime(compTime);
      } catch (err) {
        return frameIndex / fps;
      }
    }
    return frameIndex / fps;
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

  app.beginUndoGroup("Frame Plucker");

  var settings = chooseSettings();
  if (!settings) {
    app.endUndoGroup();
    return;
  }

  var output = runFfmpegDiffProbe(settings.sourceRef.file, settings.ffmpegPath, settings.searchFrames);
  var metrics = parseDiffMetrics(output);
  var detection = detectPhases(metrics, settings.period, settings.maxPhases, settings.scanFrames);
  var frameCount = getSourceFrameCount(settings.sourceRef, settings.fps);
  var keepFrames = buildKeepFrames(frameCount, settings.period, detection.phases);
  if (keepFrames.length < 2) fail("Detected cadence removes too many frames.");

  var cleanDuration = keepFrames.length / settings.fps;
  var phaseLabel = detection.phases.join("-");
  var cleanName = uniqueCompName(settings.sourceRef.baseName + "_ffmpeg_clean_p" + settings.period + "_phase" + phaseLabel);
  var cleanComp = app.project.items.addComp(
    cleanName,
    settings.sourceRef.width,
    settings.sourceRef.height,
    settings.sourceRef.pixelAspect,
    cleanDuration,
    settings.fps
  );
  cleanComp.bgColor = settings.sourceRef.bgColor;

  var cleanLayer = cleanComp.layers.add(settings.sourceRef.source);
  cleanLayer.name = settings.sourceRef.name + " ffmpeg cadence clean";
  cleanLayer.startTime = 0;
  cleanLayer.inPoint = 0;
  cleanLayer.outPoint = cleanDuration;
  cleanLayer.audioEnabled = false;
  cleanLayer.timeRemapEnabled = true;

  var remap = cleanLayer.property("ADBE Time Remapping");
  for (var i = 0; i < keepFrames.length; i++) {
    remap.setValueAtTime(i / settings.fps, getOriginalSourceTime(settings.sourceRef, keepFrames[i], settings.fps));
  }
  remap.setValueAtTime(cleanDuration, getOriginalSourceTime(settings.sourceRef, keepFrames[keepFrames.length - 1], settings.fps));
  setHoldKeys(remap);

  cleanComp.openInViewer();
  app.endUndoGroup();

  alert(
    "Clean comp created. Pattern p" + settings.period + " phase " + phasesToText(detection.phases) +
    ". Removed " + (frameCount - keepFrames.length) + "/" + frameCount +
    " frames. Confidence: " + detection.confidence + ". Window: " + detection.windowStart + "-" + detection.windowEnd + "."
  );
}());
