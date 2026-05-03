import { red } from '@mui/material/colors';
import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#66bb6a',
    },
    secondary: {
      main: '#f00c41',
    },
    error: {
      main: red.A400,
    },
    background: {
      default: '#1a1a1a',
      paper: '#2c2c2e',
    },
  },
});

export default theme;
