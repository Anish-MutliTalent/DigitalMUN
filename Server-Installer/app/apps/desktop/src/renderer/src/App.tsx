/**
 * @mun/desktop renderer — application root
 *
 * Bootstraps the store from persisted state, subscribes to the three push
 * channels (events / connection / monitoring), and routes to the role screen.
 * The Login screen is shown unauthenticated; the three role screens are wrapped
 * in the app shell (Layout).
 */

import { useEffect } from 'react';
import { useStore } from './store';
import { api } from './api';
import { Layout } from './components/Layout';
import { Toast } from './components/ui';
import { LoginScreen } from './pages/Login';
import { DelegateScreen } from './pages/Delegate';
import { ChairScreen } from './pages/Chair';
import { AdminScreen } from './pages/Admin';

export default function App() {
  const hydrated = useStore((s) => s.hydrated);
  const user = useStore((s) => s.user);
  const dispatchEvent = useStore((s) => s.dispatchEvent);
  const setConnection = useStore((s) => s.setConnection);
  const setMonitoring = useStore((s) => s.setMonitoring);
  const bootstrap = useStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
    const offEvent = api.onEvent((env) => dispatchEvent(env));
    const offConn = api.onConnection((info) => setConnection(info));
    const offMon = api.onMonitoring((state) => setMonitoring(state));
    return () => {
      offEvent();
      offConn();
      offMon();
    };
  }, [bootstrap, dispatchEvent, setConnection, setMonitoring]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        Loading…
      </div>
    );
  }

  return (
    <>
      {!user ? (
        <LoginScreen />
      ) : (
        <Layout>
          {user.role === 'delegate' ? (
            <DelegateScreen />
          ) : user.role === 'chair' ? (
            <ChairScreen />
          ) : (
            <AdminScreen />
          )}
        </Layout>
      )}
      <Toast />
    </>
  );
}
