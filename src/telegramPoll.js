export function startUploadPolling({ apiUrl, intervalMs = 1500, onNewUpload, onStatusChange }) {
  let lastSeenId = 0;
  let stopped = false;
  let timerId = null;
  let bootstrapped = false;
  const bootstrapStartedAt = Date.now();
  const bootstrapLookbackMs = 60 * 60 * 1000;

  function getUploadCreatedAt(upload) {
    const createdAt = Date.parse(upload?.createdAt || '');
    return Number.isFinite(createdAt) ? createdAt : null;
  }

  function shouldCatchBootstrapUpload(upload) {
    const createdAt = getUploadCreatedAt(upload);
    const isRecent = createdAt !== null && createdAt >= bootstrapStartedAt - bootstrapLookbackMs;
    const isUnassigned = upload?.positionIndex == null || upload?.trailNumber == null;

    return isRecent && isUnassigned;
  }

  async function bootstrapCursor() {
    try {
      const response = await fetch(`${apiUrl}/latest?since=0`);
      if (response.ok) {
        const data = await response.json();
        const uploads = Array.isArray(data.uploads) ? data.uploads : [];
        const catchableUploads = uploads.filter(shouldCatchBootstrapUpload);

        if (catchableUploads.length > 0) {
          lastSeenId = Math.max(0, Math.max(...catchableUploads.map((upload) => upload.id)) - 1);
        } else {
          lastSeenId = data.latestId || 0;
        }
      }
    } catch (error) {
      console.warn('Impossibile sincronizzare il cursore upload:', error);
    } finally {
      bootstrapped = true;
      poll();
    }
  }

  async function poll() {
    if (stopped || !bootstrapped) return;

    try {
      const response = await fetch(`${apiUrl}/latest?since=${lastSeenId}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      onStatusChange?.('connected', lastSeenId);

      for (const upload of data.uploads) {
        await onNewUpload(upload);
        lastSeenId = Math.max(lastSeenId, upload.id);
      }
    } catch (error) {
      onStatusChange?.('error', lastSeenId, error);
    }

    timerId = setTimeout(poll, intervalMs);
  }

  bootstrapCursor();

  return () => {
    stopped = true;
    if (timerId) clearTimeout(timerId);
  };
}

export async function fetchUploadAudio(apiUrl, uploadId) {
  const response = await fetch(`${apiUrl}/audio/${uploadId}`);

  if (!response.ok) {
    throw new Error(`Audio ${uploadId} non trovato`);
  }

  return response.arrayBuffer();
}
