import { installControls } from '../duck-system-properties/probe-controls';
export function activate() {
  const restore = installControls();
  return async () => {
    restore();
  };
}
