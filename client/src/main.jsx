import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App.jsx';
import ScreenErrorBoundary from './components/ScreenErrorBoundary.jsx';
import { watchServerOnLoad } from './api/system.js';
import ServerStartingBar from './components/ServerStartingBar.jsx';
import ServerHeartbeat from './features/system/ServerHeartbeat.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeProvider.jsx';

/*
 * Fonts are served from our own server (P12). At the cafe, on a 4G backup
 * line, a request to another site is a delay before the till can draw. Plex
 * Mono for every number, in the weights the type scale uses, 400 to 700.
 */
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
/*
 * Version 2: Anek for every word, variable in weight and width, with its
 * Gujarati and Devanagari siblings for the second-language line. `standard.css`
 * registers both axes (weight 100 to 800, width 75 to 125); `index.css` in the
 * same package would register weight only. IBM Plex Sans was removed in P20B.
 *
 * P32. The Gujarati and Devanagari faces are subsets of those two fonts, made
 * by `client/fontSubset.js` on every build and dev start from the characters
 * the app writes: 450 kB and 726 kB down to a few kB each. Anek Latin, first
 * in the font stack, draws every Latin character, so those two families need
 * no Latin faces of their own.
 */
import '@fontsource-variable/anek-latin/standard.css';
import './fonts/generated/second-language.css';
import './index.css';

/**
 * Server state lives here.
 *
 * Two settings worth knowing. A 401 is never retried: the API client already
 * refreshes once on TOKEN_EXPIRED, so a 401 reaching react-query means the
 * session is genuinely over and retrying just delays the login screen.
 *
 * Refetch on focus is on because two tablets open on the availability board do
 * not see each other live in v1, and coming back to a tab is the moment to
 * catch up.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error?.status === 401 || error?.status === 403) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

// P30. Before the sign-in screen: if the server has not answered in 2 seconds, say it is starting.
watchServerOnLoad();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ThemeProvider>
            <ServerStartingBar />
            <ServerHeartbeat />
            <ScreenErrorBoundary>
              <App />
            </ScreenErrorBoundary>
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
