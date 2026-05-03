import React from 'react';
import { Box, CircularProgress } from '@mui/material';

export default function Spinner() {
  return (
    <Box
      className="fill"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <CircularProgress />
    </Box>
  );
}
