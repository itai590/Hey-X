import React from 'react';
import { render, screen } from '@testing-library/react';
import ErrorBanner from './ErrorBanner';

describe('ErrorBanner', () => {
  test('renders message', () => {
    render(<ErrorBanner message="Server unreachable" />);
    expect(screen.getByText(/Server unreachable/)).toBeInTheDocument();
  });
});
