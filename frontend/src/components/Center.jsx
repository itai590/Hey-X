import React from 'react';
import { Box } from '@mui/material';

export default function Center({ sx, ...rest }) {
  return (
    <Box
      className="fill"
      sx={[
        {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        },
        ...(sx ? [sx] : []),
      ]}
      {...rest}
    />
  );
}
