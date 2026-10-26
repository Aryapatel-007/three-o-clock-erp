import { Component } from 'react';

import Button from './ui/Button.jsx';
import { TriangleIcon } from './ui/icons/index.jsx';

/**
 * The last word when a screen fails to draw, instead of a blank page.
 *
 * 2026-10-18. Mostly a screen whose code could not be fetched: no connection,
 * or a stale tab after a deploy that loadScreen's one reload did not cure. A
 * class, because React catches render errors only in a class component; the
 * one exception to CONVENTIONS section 10's function components.
 */
export default class ScreenErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="v2 flex min-h-screen items-center justify-center bg-ground px-4 text-ink">
        <div role="alert" className="w-full max-w-md rounded-[10px] border border-line border-l-[3px] border-l-alert bg-surface p-6">
          <p className="type-heading flex items-start gap-2">
            <TriangleIcon className="mt-1 text-alert" />
            <span>This screen could not load.</span>
          </p>
          <p className="type-body mt-2 text-muted">Check the connection, then reload. Nothing you saved is lost.</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </main>
    );
  }
}
