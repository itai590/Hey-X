import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

/** Match presence polling in Home (2s) so the list and ring update together. */
const POLL_MS = 2000;

/**
 * Fetches /api/messages on a fixed interval (like presence in Home) so barks
 * are not missed when the tab is hidden on first load or in browsers that
 * defer the visibility "visible" path.
 *
 * Also tracks newly-arrived bark messages that carry a clip_id, exposing them
 * as `newBarkClips` so the UI can show a confirmation card for each one.
 * A message counts as "new" if its update_time is within the last 90 seconds
 * and its id has not been seen before in this session.
 */
export default function useMessages() {
  const isMounted = useRef(true);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [newBarkClips, setNewBarkClips] = useState([]);

  // Track message ids we have already emitted as new-bark events
  const seenIds = useRef(new Set());
  // On first load we populate seenIds without emitting so old barks don't pop up
  const firstLoad = useRef(true);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/messages'), { cache: 'no-store' });
      if (!isMounted.current) return;
      if (!res.ok) {
        throw new Error(`Failed to fetch messages, status: ${res.status}`);
      }
      const data = await res.json();
      if (!isMounted.current) return;
      setMessages(data);
      setError(null);

      const nowMs = Date.now();
      const fresh = [];
      for (const msg of data) {
        if (seenIds.current.has(msg.id)) continue;
        seenIds.current.add(msg.id);
        if (firstLoad.current) continue; // don't surface pre-existing barks on mount
        // Emit only if the bark happened within the last 90 seconds and has a clip
        if (msg.clip_id) {
          const ageMs = nowMs - new Date(msg.update_time).getTime();
          if (ageMs < 90_000) {
            fresh.push({ clipId: msg.clip_id, messageId: msg.id });
          }
        }
      }
      firstLoad.current = false;
      if (fresh.length > 0) {
        setNewBarkClips((prev) => [...prev, ...fresh]);
      }
    } catch (err) {
      if (!isMounted.current) return;
      console.error('Fetch error:', err);
      setError('Could not connect to server');
    }
  }, []);

  const dismissBarkClip = useCallback((clipId) => {
    setNewBarkClips((prev) => prev.filter((c) => c.clipId !== clipId));
  }, []);

  useEffect(() => {
    isMounted.current = true;
    void loadMessages();
    const id = setInterval(loadMessages, POLL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(id);
    };
  }, [loadMessages]);

  return { messages, error, reload: loadMessages, newBarkClips, dismissBarkClip };
}
