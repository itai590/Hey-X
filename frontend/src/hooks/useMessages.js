import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../apiBase';

/** Match presence polling in Home (2s) so the list and ring update together. */
const POLL_MS = 2000;

/**
 * Fetches /api/messages on a fixed interval (like presence in Home) so barks
 * are not missed when the tab is hidden on first load or in browsers that
 * defer the visibility "visible" path.
 */
export default function useMessages() {
  const isMounted = useRef(true);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);

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
    } catch (err) {
      if (!isMounted.current) return;
      console.error('Fetch error:', err);
      setError('Could not connect to server');
    }
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

  return { messages, error, reload: loadMessages };
}
