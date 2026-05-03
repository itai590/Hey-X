import React, { useMemo, useEffect, useState, useContext, useCallback } from 'react';
import { Typography, Grid, Divider, Fab, useTheme } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import Spinner from './Spinner';
import Center from './Center';
import useStorageValue from '../hooks/withStorageValue';
import Editor from './Editor';
import mainContext from '../context';
import { apiUrl } from '../apiBase';
import { apiFetch } from '../apiClient';

export default function Document({ path, id, view }) {
  const context = useContext(mainContext);
  const theme = useTheme();
  const [raw, setRaw] = useState();
  const [s, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [debug] = useStorageValue('debug');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(apiUrl('/messages'));
        const data = await res.json();
        const message = data.find(m => m.id === id || id === undefined);
        if (message) {
          setSnapshot({ exists: true, data: () => message });
          setRaw(JSON.stringify(message, null, 2));
        } else {
          setSnapshot({ exists: false });
        }
      } catch (err) {
        console.error(err);
        setError(err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [id]);

  const save = useCallback(async () => {
    try {
      const data = JSON.parse(raw);
      const res = await apiFetch(`/messages/${id}`, { method: 'PUT', json: data });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      console.log('Saved!');
    } catch (err) {
      console.error(err);
      alert('Save failed');
    }
  }, [id, raw]);

  const Wrapper = useMemo(() => {
    return !context.depth && debug
      ? ({ rawData, children }) => (
          <Grid container direction="row" className="fill" style={{ position: 'relative' }}>
            <Grid size="grow" className="fill scroll" style={{ maxWidth: 400 }}>
              {children}
            </Grid>
            <Divider />
            <Grid size="grow" className="fill scroll">
              <Editor onChange={setRaw} value={rawData} />
              <Fab onClick={save} style={{
                position: 'absolute',
                bottom: theme.spacing(2),
                right: theme.spacing(2),
              }}>
                <SaveIcon />
              </Fab>
            </Grid>
          </Grid>
        )
      : ({ children }) => children;
  }, [context.depth, debug, save, theme]);

  return loading ? <Spinner />
    : error ? <ErrorBlock message={`path=${path} error=${JSON.stringify(error)}`} />
    : s?.exists
      ? <mainContext.Provider value={{
          ...context,
          depth: ((context && context.depth) || 0) + 1
        }}>
        <Wrapper rawData={raw}>
          <div style={{ padding: '2rem' }}>
            <h2>Bark</h2>
            <p>{s.data().text}</p>
          </div>
        </Wrapper>
        </mainContext.Provider>
      : <ErrorBlock status={404} />;
}

function ErrorBlock({ status, message }) {
  return (
    <Center>
      <Grid container direction="column" alignItems="center">
        {status === 404
          ? <Typography variant="h1" color="textSecondary">404</Typography>
          : <>
              <Typography variant="h6">Sh*t!@#$</Typography>
              <Typography variant="body2">{message}</Typography>
            </>
        }
      </Grid>
    </Center>
  );
}
