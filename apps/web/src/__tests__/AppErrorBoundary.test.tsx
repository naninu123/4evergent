import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom';
import { AppErrorBoundary } from '../App';

let didThrow = false;

function ThrowsOnFirstRender() {
  if (!didThrow) {
    didThrow = true;
    throw new Error('render failed');
  }
  return <p>Recovered dashboard</p>;
}

describe('AppErrorBoundary', () => {
  beforeEach(() => { didThrow = false; });

  it('shows a recoverable screen after a render error', () => {
    render(<AppErrorBoundary><ThrowsOnFirstRender /></AppErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('render failed');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered dashboard')).toBeInTheDocument();
  });
});
