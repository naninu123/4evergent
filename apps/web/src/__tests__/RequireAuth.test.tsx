import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { ApiError, notifySessionExpired, isUnauthorizedError } from '../api';

const { mockGetStoredToken, mockClearAuth, mockApiMe, mockApiListAgents } = vi.hoisted(() => ({
  mockGetStoredToken: vi.fn(),
  mockClearAuth: vi.fn(),
  mockApiMe: vi.fn(),
  mockApiListAgents: vi.fn(),
}));

vi.mock('../auth', () => ({
  getStoredToken: mockGetStoredToken,
  clearAuth: mockClearAuth,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: mockApiMe,
      listAgents: mockApiListAgents,
    },
  };
});

vi.mock('../pages/Login', () => ({
  default: ({ onSuccess }: { onSuccess: () => void }) => (
    <div data-testid="login-page">
      <span>Login Screen</span>
      <button onClick={onSuccess}>Simulate Login</button>
    </div>
  ),
}));

import { RequireAuth, validateSession } from '../RequireAuth';

function renderAuth() {
  return render(
    <RequireAuth>
      <div data-testid="dashboard">Dashboard Content</div>
    </RequireAuth>
  );
}

describe('validateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns true when api.me() succeeds (cookie session)', async () => {
    mockApiMe.mockResolvedValue({ id: 'user-1' });

    const result = await validateSession();

    expect(result).toBe(true);
    expect(mockApiMe).toHaveBeenCalledTimes(1);
    expect(mockGetStoredToken).not.toHaveBeenCalled();
    expect(mockClearAuth).not.toHaveBeenCalled();
  });

  test('falls back to stored bearer token when api.me() returns 401', async () => {
    mockApiMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockGetStoredToken.mockReturnValue('legacy-token');
    mockApiListAgents.mockResolvedValue({ agents: [] });

    const result = await validateSession();

    expect(result).toBe(true);
    expect(mockApiListAgents).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).not.toHaveBeenCalled();
  });

  test('clears auth and returns false when stored token validation fails', async () => {
    mockApiMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockGetStoredToken.mockReturnValue('bad-token');
    mockApiListAgents.mockRejectedValue(new Error('Invalid token'));

    const result = await validateSession();

    expect(result).toBe(false);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test('returns false without clearing auth when 401 and no stored token exists', async () => {
    mockApiMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockGetStoredToken.mockReturnValue(null);

    const result = await validateSession();

    expect(result).toBe(false);
    expect(mockClearAuth).not.toHaveBeenCalled();
  });

  test('returns false without clearing auth on server or network error', async () => {
    mockApiMe.mockRejectedValue(new ApiError(500, 'Server Error'));

    const result500 = await validateSession();
    expect(result500).toBe(false);
    expect(mockClearAuth).not.toHaveBeenCalled();

    mockApiMe.mockRejectedValue(new TypeError('Failed to fetch'));
    const resultNetwork = await validateSession();
    expect(resultNetwork).toBe(false);
    expect(mockClearAuth).not.toHaveBeenCalled();
  });
});

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('shows verifying state while session check is in flight', () => {
    mockApiMe.mockReturnValue(new Promise(() => {})); // pending forever

    renderAuth();

    expect(screen.getByText('4evergent')).toBeInTheDocument();
    expect(screen.getByText('Verifying session...')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  test('renders children when session is valid', async () => {
    mockApiMe.mockResolvedValue({ id: 'user-1' });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByText('Verifying session...')).not.toBeInTheDocument();
  });

  test('renders Login component when unauthenticated', async () => {
    mockApiMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockGetStoredToken.mockReturnValue(null);

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  test('renders children after successful login callback', async () => {
    mockApiMe.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    mockGetStoredToken.mockReturnValue(null);

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Simulate Login' }));

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  test('mid-session 401 expiry shows session-ended notice, returns to Login, and restores the page after re-login', async () => {
    mockApiMe.mockResolvedValue({ id: 'user-1' });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });

    act(() => {
      notifySessionExpired(new ApiError(401, 'unauthorized', 'UNAUTHORIZED'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
    const notice = screen.getByTestId('session-expired-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/session has ended/i);
    expect(notice).toHaveTextContent(/sign in again/i);
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    expect(mockClearAuth).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Simulate Login' }));

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('session-expired-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  test('non-401 error is not treated as session expiry and does not clear credentials or unmount the page', async () => {
    mockApiMe.mockResolvedValue({ id: 'user-1' });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });

    const err500 = new ApiError(500, 'Internal Server Error');
    const errNet = new TypeError('Failed to fetch');
    expect(isUnauthorizedError(err500)).toBe(false);
    expect(isUnauthorizedError(errNet)).toBe(false);

    act(() => {
      expect(notifySessionExpired(err500)).toBe(false);
      expect(notifySessionExpired(errNet)).toBe(false);
    });

    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('session-expired-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    expect(mockClearAuth).not.toHaveBeenCalled();
  });
});
