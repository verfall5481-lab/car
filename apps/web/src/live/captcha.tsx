import { useEffect, useRef, useState } from 'react';
import { copy } from '../copy.ts';

type Turnstile = {
  render(element: HTMLElement, options: { sitekey: string; size: 'flexible'; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }): string;
  remove(id: string): void;
};
let scriptPromise: Promise<Turnstile> | undefined;
function turnstileApi() {
  return (window as Window & { turnstile?: Turnstile }).turnstile;
}
function loadTurnstile(): Promise<Turnstile> {
  const existing = turnstileApi();
  if (existing) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(fail, 8000);
    function fail() { window.clearTimeout(timeout); script.remove(); reject(new Error('Turnstile unavailable')); }
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      window.clearTimeout(timeout);
      const api = turnstileApi();
      if (api) resolve(api);
      else fail();
    };
    document.head.append(script);
  });
  void scriptPromise.catch(() => { scriptPromise = undefined; });
  return scriptPromise;
}

export function Captcha({ siteKey, receive }: { siteKey: string; receive: (token: string) => void }) {
  const node = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let mounted = true;
    let instance: { api: Turnstile; id: string } | undefined;
    void loadTurnstile().then((api) => {
      if (!mounted || !node.current) return;
      const id = api.render(node.current, { sitekey: siteKey, size: 'flexible', callback: (token) => { if (mounted) receive(token); },
        'expired-callback': () => { if (mounted) receive(''); }, 'error-callback': () => { if (mounted) { receive(''); setFailed(true); } } });
      instance = { api, id };
    }).catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; if (instance) instance.api.remove(instance.id); };
  }, [siteKey, receive, revision]);
  return <div className="stack"><div ref={node} aria-label={copy.captchaLabel} />{failed && <><p role="alert" className="danger-text">{copy.captchaError}</p><button className="button button--outline" type="button" onClick={() => { setFailed(false); setRevision((value) => value + 1); }}>{copy.retry}</button></>}</div>;
}
