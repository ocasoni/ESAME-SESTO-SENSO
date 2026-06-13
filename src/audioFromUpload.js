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

export async function extractBreathFramesFromArrayBuffer(arrayBuffer, settings, maxDuration = 30) {
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

  return new Promise((resolve, reject) => {
    const frames = [];
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.86;
    source.connect(analyserNode);

    const frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
    const waveformData = new Uint8Array(analyserNode.fftSize);
    const duration = Math.min(audioBuffer.duration, maxDuration);
    const sampleInterval = 1 / 60;
    let nextSample = 0;

    source.start(0);

    const tick = () => {
      const elapsed = ctx.currentTime;

      if (elapsed >= duration) {
        source.stop();
        ctx.close().catch(() => {});
        resolve(frames);
        return;
      }

      if (elapsed >= nextSample) {
        analyserNode.getByteFrequencyData(frequencyData);
        analyserNode.getByteTimeDomainData(waveformData);
        frames.push(analyzeBreathFrame(frequencyData, waveformData, settings));
        nextSample += sampleInterval;
      }

      requestAnimationFrame(tick);
    };

    source.addEventListener('error', (error) => {
      ctx.close().catch(() => {});
      reject(error);
    });

    requestAnimationFrame(tick);
  });
}
