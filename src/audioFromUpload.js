export function analyzeBreathFrame(frequencyData, waveformData, settings) {
  let sum = 0;

  for (let i = 0; i < waveformData.length; i++) {
    const v = (waveformData[i] - 128) / 128;
    sum += v * v;
  }

  const rms = Math.sqrt(sum / waveformData.length);
  const noiseFloor = 0.006;
  const cleanedRms = Math.max(0, rms - noiseFloor);

  const level = Math.min(1, Math.max(0, cleanedRms * settings.breathSensitivity));

  const breathEnd = Math.floor(frequencyData.length * 0.035);
  const lowStart = breathEnd;
  const lowEnd = Math.floor(frequencyData.length * 0.12);
  const midStart = lowEnd;
  const midEnd = Math.floor(frequencyData.length * 0.34);
  const highStart = midEnd;
  const highEnd = Math.floor(frequencyData.length * 0.72);

  let lowBand = 0;
  let midBand = 0;
  let highBand = 0;

  for (let i = lowStart; i < lowEnd; i++) {
    const value = frequencyData[i] / 255;
    lowBand += value * value;
  }

  for (let i = midStart; i < midEnd; i++) {
    const value = frequencyData[i] / 255;
    midBand += value * value;
  }

  for (let i = highStart; i < highEnd; i++) {
    const value = frequencyData[i] / 255;
    highBand += value * value;
  }

  lowBand = Math.sqrt(lowBand / Math.max(1, lowEnd - lowStart));
  midBand = Math.sqrt(midBand / Math.max(1, midEnd - midStart));
  highBand = Math.sqrt(highBand / Math.max(1, highEnd - highStart));

  lowBand = Math.min(1, Math.max(0, lowBand * settings.lowSensitivity));
  midBand = Math.min(1, Math.max(0, midBand * settings.midSensitivity));
  highBand = Math.min(1, Math.max(0, highBand * settings.highSensitivity));

  return { level, lowBand, midBand, highBand };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

async function decodeUploadedAudio(arrayBuffer) {
  if (typeof OfflineAudioContext !== 'undefined') {
    const offlineContext = new OfflineAudioContext(1, 1, 44100);
    return offlineContext.decodeAudioData(arrayBuffer.slice(0));
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();

  try {
    return await context.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    context.close?.().catch(() => {});
  }
}

function getMonoChannelData(audioBuffer) {
  const { length, numberOfChannels } = audioBuffer;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = audioBuffer.getChannelData(channel);

    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / numberOfChannels;
    }
  }

  return mono;
}

function analyzeOfflineBreathFrame(samples, startIndex, windowSize, settings) {
  let sumSq = 0;
  let lowSumSq = 0;
  let highSumSq = 0;
  let low = 0;
  let previous = samples[Math.max(0, startIndex - 1)] || 0;

  for (let i = 0; i < windowSize; i++) {
    const sample = samples[startIndex + i] || 0;
    const diff = sample - previous;

    low += (sample - low) * 0.08;
    sumSq += sample * sample;
    lowSumSq += low * low;
    highSumSq += diff * diff;

    previous = sample;
  }

  const rms = Math.sqrt(sumSq / windowSize);
  const lowRms = Math.sqrt(lowSumSq / windowSize);
  const highRms = Math.sqrt(highSumSq / windowSize) * 0.5;
  const midRms = Math.sqrt(Math.max(0, rms * rms - lowRms * lowRms * 0.65 - highRms * highRms * 0.35));

  const noiseFloor = 0.006;
  const cleanedRms = Math.max(0, rms - noiseFloor);
  const level = clamp01(cleanedRms * settings.breathSensitivity);
  const lowBand = clamp01(lowRms * settings.lowSensitivity * 2.0);
  const midBand = clamp01(midRms * settings.midSensitivity * 1.5);
  const highBand = clamp01(highRms * settings.highSensitivity * 0.9);
  const spectralCentroid = clamp01(highBand * 0.7 + midBand * 0.35 - lowBand * 0.2);

  return {
    level,
    lowBand,
    midBand,
    highBand,
    spectralCentroid,
  };
}

export async function extractBreathFramesFromArrayBuffer(arrayBuffer, settings, maxDuration = 30) {
  const audioBuffer = await decodeUploadedAudio(arrayBuffer);
  const samples = getMonoChannelData(audioBuffer);
  const duration = Math.min(audioBuffer.duration, maxDuration);
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = Math.max(1, Math.floor(duration * 60));
  const windowSize = Math.min(2048, samples.length);
  const frames = [];

  for (let i = 0; i < frameCount; i++) {
    const frameTime = i / 60;
    const startIndex = Math.min(
      Math.max(0, Math.floor(frameTime * sampleRate)),
      Math.max(0, samples.length - windowSize)
    );

    frames.push(analyzeOfflineBreathFrame(samples, startIndex, windowSize, settings));
  }

  return { frames, audioBuffer };
}
