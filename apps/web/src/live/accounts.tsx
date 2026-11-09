import { useEffect, useState } from 'react';
import { Bell, Check, Clock3, PlusSquare, Share, Smartphone } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { copy } from '../copy.ts';
import { RiderInstallCode, RiderInstallSteps, RiderLocationIllustration, RiderPairHeading } from '../rider.tsx';
import { browserPosition } from './maps.tsx';
import { Button, CodeInput, MobileHeader, Sheet, useToast } from '../ui.tsx';
import { FamilyChoices, InviteQr, NicknameOptions } from '../guardian-onboarding.tsx';
import { NotificationLayout } from '../guardian.tsx';
import { dataObject, RpcError, sameRoleReturn } from './api.ts';
import type { Surface } from './api.ts';
import { describeError, useClient, useLiveConfig, useLiveMutation } from './context.tsx';
import { claimSchema, inviteSchema } from './models.ts';
import { currentSubscription, isIOS, isStandalone, subscribePush, unsubscribePush } from './platform.ts';
import { Captcha } from './captcha.tsx';

export const privacyVersion = '2026-11-04';
const returnKey = 'deriro-parent-return';
const linkKey = 'deriro-child-pair-code';
export function e164(value: string) {
  const trimmed = value.trim().replace(/[()\s-]/g, '');
  if (/^0\d{8,10}$/.test(trimmed)) return `+82${trimmed.slice(1)}`;
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  return trimmed ? null : '';
}
const riderCode = (value: string) => value.replace(/\D/g, '').slice(0, 8);
const familyCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function savePairCode(code: string) {
  if (isIOS() || code.length !== 8) return;
  try {
    const old = JSON.parse(localStorage.getItem(linkKey) ?? 'null') as { code?: string; expiresAt?: number } | null;
    if (old?.code !== code) localStorage.setItem(linkKey, JSON.stringify({ code, expiresAt: Date.now() + 10 * 60_000 }));
  } catch { /* The code remains visible on the install screen. */ }
}
function pendingPairCode() {
  if (isIOS()) return '';
  try {
    const pending = JSON.parse(localStorage.getItem(linkKey) ?? 'null') as { code?: string; expiresAt?: number } | null;
    if (pending?.expiresAt && pending.expiresAt > Date.now() && pending.code) return riderCode(pending.code);
    localStorage.removeItem(linkKey);
  } catch { /* Invalid or inaccessible stored values are ignored. */ }
  return '';
}

export function rememberReturn(path: string) {
  try { sessionStorage.setItem(returnKey, sameRoleReturn(path, window.location.origin)); } catch { /* The home screen is the fallback. */ }
}
export function retrieveReturn() {
  try { const value = sessionStorage.getItem(returnKey); sessionStorage.removeItem(returnKey); return sameRoleReturn(value, window.location.origin); } catch { return '/p/'; }
}

export function GuardianLogin() {
  const { supabase } = useClient();
  const { captchaKey, kakaoLogin } = useLiveConfig();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [codeStep, setCodeStep] = useState(false);
  const [useBrowser, setUseBrowser] = useState(() => !isIOS() || isStandalone());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [time, setTime] = useState(Date.now);
  const [captcha, setCaptcha] = useState('');
  const [captchaRevision, setCaptchaRevision] = useState(0);
  useEffect(() => {
    if (!codeStep) return;
    const timer = window.setInterval(() => setTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [codeStep]);
  async function send() {
    if (captchaKey && !captcha) return;
    setError(''); setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true, captchaToken: captcha || undefined } });
      if (error) throw new RpcError(error.status === 429 ? 'RATE_LIMITED' : 'OTP_SEND');
      setCodeStep(true); setResendAt(Date.now() + 60_000); setTime(Date.now());
    } catch (error) { setError(describeError(error)); }
    finally { setLoading(false); setCaptcha(''); setCaptchaRevision((value) => value + 1); }
  }
  async function startKakao() {
    setLoading(true); setError('');
    try {
      const { error } = await supabase.auth.signInWithOAuth({ provider: 'kakao', options: { redirectTo: `${window.location.origin}/p/auth/callback` } });
      if (error) setError(copy.oauthError);
    } catch { setError(copy.oauthError); }
    finally { setLoading(false); }
  }
  async function verify() {
    setError(''); setLoading(true);
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
      if (error || !data.session || data.user?.is_anonymous) throw new RpcError('OTP_INVALID');
    } catch (error) { setError(describeError(error)); }
    finally { setLoading(false); }
  }
  return <><MobileHeader title={copy.app} className="guardian-brand-header" /><div className="mobile-content guardian-account">
    {!useBrowser ? <div className="stack"><div className="guardian-account-intro"><h2>{copy.loginTitle}</h2><p className="muted">{copy.loginDescription}</p></div><div className="guardian-account-help"><Smartphone size={28} /><p>{copy.iosInstallLogin}</p></div><Link className="button button--primary" to="/p/install">{copy.installHelp}</Link><Button variant="plain" onClick={() => setUseBrowser(true)}>{copy.browserContinue}</Button></div> :
      <form className="stack edit-form" onSubmit={(event) => { event.preventDefault(); void (codeStep ? verify() : send()); }}>
        <div className="guardian-account-intro"><h2>{codeStep ? copy.otpTitle : copy.loginTitle}</h2><p className="muted">{codeStep ? copy.otpDescription : copy.loginDescription}</p></div>
        {codeStep ? <><p>{email}</p><CodeInput label={copy.otpTitle} length={6} value={token} invalid={Boolean(error)} onChange={(value) => { setToken(value); setError(''); }} /></> :
          <label className="field">{copy.email}<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder={copy.emailExample} /></label>}
        {error && <p role="alert" className="danger-text">{error}</p>}
        {captchaKey && (!codeStep || time >= resendAt) && <Captcha key={captchaRevision} siteKey={captchaKey} receive={setCaptcha} />}
        <Button type="submit" disabled={loading || (codeStep ? token.length !== 6 : !email.trim() || Boolean(captchaKey && !captcha))}>{loading ? copy.loading : codeStep ? copy.confirm : copy.getOtp}</Button>
        {codeStep ? <><Button variant="secondary" disabled={loading || time < resendAt || Boolean(captchaKey && !captcha)} onClick={() => { void send(); }}>{copy.resend}{time < resendAt ? ` (${Math.ceil((resendAt - time) / 1000)}초)` : ''}</Button><Button variant="plain" onClick={() => { setToken(''); setCodeStep(false); setError(''); }}>{copy.changeEmail}</Button></> :
          <>{kakaoLogin && <Button variant="amber" disabled={loading} onClick={() => { void startKakao(); }}>{copy.loginKakao}</Button>}<div className="guardian-account-help"><Smartphone size={26} /><div><p>{copy.addHome}</p><Link to="/p/install">{copy.installHelp}</Link></div></div></>}
      </form>}
  </div></>;
}

export function GuardianOAuthCallback() {
  const { supabase } = useClient();
  const { kakaoLogin } = useLiveConfig();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(!kakaoLogin || !params.get('code'));
  const code = params.get('code');
  useEffect(() => {
    if (!kakaoLogin || !code) return;
    let current = true;
    void supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
      if (!current) return;
      if (error || !data.session || data.user?.is_anonymous) setFailed(true);
      else navigate(retrieveReturn(), { replace: true });
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [code, kakaoLogin, navigate, supabase]);
  return <><MobileHeader title={copy.app} /><div className="mobile-content stack">{failed ? <><p role="alert" className="danger-text">{copy.oauthError}</p><Link className="button button--primary" to="/p/login" replace>{copy.back}</Link></> : <p role="status">{copy.loading}</p>}</div></>;
}

export function FamilySetup({ join = false }: { join?: boolean }) {
  const navigate = useNavigate();
  const client = useClient();
  const [params] = useSearchParams();
  const showForm = join || params.get('profile') === '1';
  const [code, setCode] = useState(familyCode(params.get('code') ?? ''));
  const [inspectCode, setInspectCode] = useState(join ? code : '');
  const [inspectAttempt, setInspectAttempt] = useState(0);
  const [invitation, setInvitation] = useState<{ code: string; family_name: string; inviter_name: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [phone, setPhone] = useState('');
  const [sms, setSms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [location, setLocation] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const { run, pending } = useLiveMutation();
  useEffect(() => {
    if (!join || inspectCode.length !== 8) return;
    const abort = new AbortController();
    setChecking(true); setInviteError('');
    void client.rpc('preview_family_invite', { p_code: inspectCode }, z.object({ family_name: z.string(), inviter_name: z.string() }), abort.signal)
      .then((result) => { if (!abort.signal.aborted) setInvitation({ code: inspectCode, ...result }); })
      .catch((error) => { if (!abort.signal.aborted) { setInviteError(describeError(error)); setInvitation(null); } })
      .finally(() => { if (!abort.signal.aborted) setChecking(false); });
    return () => abort.abort();
  }, [client, inspectCode, inspectAttempt, join]);
  const readyToJoin = invitation?.code === code;
  return <><MobileHeader title={copy.app} className="guardian-brand-header" back={showForm ? '/p/onboarding' : undefined} />
    {!showForm ? <FamilyChoices create={() => navigate('/p/onboarding?profile=1')} /> : <div className="mobile-content guardian-account">
      <form className="stack edit-form" onSubmit={async (event) => {
        event.preventDefault();
        const normalized = e164(phone);
        if (normalized == null) return;
        const saved = await run(join ? 'join_family' : 'create_family', {
          p_display_name: name.trim(), p_phone_e164: normalized || undefined, p_sms_opt_in: Boolean(normalized && sms),
          p_privacy_version: privacyVersion, p_location_consent: location,
          ...(join ? { p_code: code } : { p_family_name: familyName.trim() || undefined }),
        });
        if (saved) navigate('/p/notifications', { replace: true });
      }}>
        <div className="guardian-account-intro"><h2>{join ? readyToJoin && invitation ? copy.joinPreview(invitation.inviter_name) : copy.joinTitle : copy.info}</h2><p className="muted">{join && readyToJoin && invitation ? invitation.family_name : copy.setupProfileDescription}</p></div>
        {join ? <><label className="field guardian-invite-code">{copy.familyInviteCode}<input autoComplete="off" maxLength={9} required value={code} onChange={(event) => { setCode(familyCode(event.target.value)); setInspectCode(''); setChecking(false); setInviteError(''); }} /></label>
          {(!readyToJoin || !invitation) &&
            <Button variant="outline" disabled={checking || code.length !== 8} onClick={() => { setInspectCode(code); setInspectAttempt((value) => value + 1); }}>{checking ? copy.loading : copy.checkInvite}</Button>}
          {inviteError && <p role="alert" className="danger-text">{inviteError}</p>}</> :
          <label className="field">{copy.familyName}<input maxLength={40} value={familyName} onChange={(event) => setFamilyName(event.target.value)} placeholder={copy.familyNamePlaceholder} /></label>}
        <div className="stack guardian-name-fields"><label className="field">{copy.guardianNickname}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} required autoComplete="nickname" placeholder={copy.namePlaceholder} /></label><NicknameOptions name={name} choose={setName} /><p className="small muted">{copy.guardianNicknameHint}</p></div>
        <label className="field">{copy.phone}<input type="tel" autoComplete="tel" maxLength={22} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder={copy.phoneFormat} /></label>
        <label className="checkbox guardian-approval"><input type="checkbox" checked={sms} disabled={!e164(phone)} onChange={(event) => setSms(event.target.checked)} />{copy.messageNotification}</label>
        <div className="guardian-consent"><label className="checkbox guardian-approval"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />{copy.privacyConsent}</label><Button variant="plain" onClick={() => setPrivacy(true)} aria-label={copy.privacyPolicy}>{copy.viewFull}</Button></div>
        <label className="checkbox guardian-approval"><input type="checkbox" checked={location} onChange={(event) => setLocation(event.target.checked)} />{copy.consentSelf}</label>
        {e164(phone) == null && <p className="danger-text" role="alert">{copy.invalidInput}</p>}
        <Button type="submit" disabled={pending || !name.trim() || !consent || e164(phone) == null || join && !readyToJoin}>{pending ? copy.loading : join ? copy.joinFamily : copy.newFamily}</Button>
        {join && isIOS() && !isStandalone() && <p className="guardian-install-tip"><Smartphone size={19} />{copy.continueAfterInstall}</p>}
      </form>
    {privacy && <Sheet title={copy.privacyPolicy} close={() => setPrivacy(false)}><p>{copy.livePrivacy}</p><Button onClick={() => setPrivacy(false)}>{copy.close}</Button></Sheet>}
  </div>}</>;
}

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
export function InstallGuide({ surface, hasCode = false }: { surface: Surface; hasCode?: boolean }) {
  const [params] = useSearchParams();
  const code = riderCode(params.get('code') ?? '');
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => { if (surface === 'rider' && hasCode) savePairCode(code); }, [code, surface, hasCode]);
  useEffect(() => {
    const handle = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const done = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', handle);
    window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', handle); window.removeEventListener('appinstalled', done); };
  }, []);
  const rider = surface === 'rider';
  function passCode() { savePairCode(code); }
  return <><MobileHeader title={copy.app} back={rider ? '/c/' : '/p/login'} className={rider ? 'mobile-header--rider' : undefined} /><div className={`mobile-content install-page${rider ? ' rider-install' : ''}`}>
    <h2>{installed ? copy.installed : rider ? copy.installFirst : copy.iosInstallLogin}</h2>
    {!installed && (prompt ? <>{rider && <span className="rider-install-app">{copy.app}</span>}<Button onClick={async () => { passCode(); await prompt.prompt(); const result = await prompt.userChoice; setPrompt(null); if (result.outcome === 'accepted') setInstalled(true); }}>{copy.addHome}</Button></> :
      rider ? <RiderInstallSteps /> : <ol>{[[Share, copy.shareButton], [PlusSquare, copy.addHome], [Smartphone, copy.openHome]].map(([Icon, label], index) => { const StepIcon = Icon as typeof Share; return <li key={index}><span><StepIcon size={22} /></span><strong>{String(label)}</strong></li>; })}</ol>)}
    {hasCode && code.length === 8 && <RiderInstallCode code={code} privacy />}
    <Link onClick={passCode} className={`button ${rider && !installed ? 'button--plain rider-install-skip' : 'button--primary'}`} to={rider ? `/c/link${code.length === 8 ? `?code=${code}` : ''}` : '/p/login'}>{installed ? copy.continue : copy.useWithoutInstall}</Link>
  </div></>;
}

export function PairRider({ revoked = false, signedIn = false }: { revoked?: boolean; signedIn?: boolean }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useClient();
  const { captchaKey } = useLiveConfig();
  const query = useQueryClient();
  const [code, setCode] = useState(() => riderCode(params.get('code') ?? pendingPairCode()));
  const [autofilled, setAutofilled] = useState(code.length === 8);
  const [consentNeeded, setConsentNeeded] = useState(false);
  const [consent, setConsent] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  const [locationPrompt, setLocationPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(revoked ? copy.revokedDevice : '');
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [captcha, setCaptcha] = useState('');
  const [captchaRevision, setCaptchaRevision] = useState(0);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      if (stamp >= retryUntil) setRetryUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);
  async function connect(switchRider = false) {
    setBusy(true); setError('');
    try {
      const { data } = await client.supabase.auth.getSession();
      if (!data.session) {
        if (captchaKey && !captcha) throw new RpcError('CAPTCHA_REQUIRED');
        const { error } = await client.supabase.auth.signInAnonymously({ options: { captchaToken: captcha || undefined } });
        setCaptcha(''); setCaptchaRevision((value) => value + 1);
        if (error) throw new RpcError(error.status === 429 ? 'RATE_LIMITED' : 'NOT_AUTHENTICATED');
      }
      const result = await client.rpc('claim_rider_invite', { p_code: code, p_user_agent: navigator.userAgent.slice(0, 200), p_confirm_switch: switchRider, p_consent: consent ? privacyVersion : undefined }, claimSchema);
      if ('needs_switch_confirm' in result) { setSwitching(true); return; }
      if (switchRider) await unsubscribePush(client, true).catch(() => {});
      setSwitching(false); setLinked(result.rider.display_name);
      try { localStorage.removeItem(linkKey); } catch { /* Storage might be disabled. */ }
      query.removeQueries({ queryKey: ['rider-state'] });
      navigate('/c/link', { replace: true });
    } catch (error) {
      setSwitching(false);
      if (error instanceof RpcError && error.code === 'CONSENT_REQUIRED') setConsentNeeded(true);
      if (error instanceof RpcError && ['INVITE_USED', 'INVITE_EXPIRED', 'INVITE_INVALID'].includes(error.code)) {
        try { localStorage.removeItem(linkKey); } catch { /* Storage might be disabled. */ }
      }
      if (error instanceof RpcError && error.code === 'RATE_LIMITED') {
        const detail = error.detail as { retry_after_sec?: number } | undefined;
        const stamp = Date.now();
        setNow(stamp); setRetryUntil(stamp + Math.max(1, detail?.retry_after_sec ?? 60) * 1000);
      }
      setError(describeError(error));
    } finally { setBusy(false); }
  }
  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000));
  const invalid = error === copy.codeNotValid;
  const showInlineError = error && !retrySeconds && error !== copy.codeExpired && error !== copy.codeUsed && error !== copy.rateLimited;
  const ready = !busy && code.length === 8 && !retrySeconds && (!consentNeeded || consent) && (!captchaKey || signedIn || Boolean(captcha));
  return <><MobileHeader title={copy.app} back="/c/" className="mobile-header--rider" /><div className="mobile-content connection-page rider-pair">
    {linked !== null ? locationPrompt ? <div className="rider-pair-success rider-pair-location">
      <h2>{copy.locationAtRequest}</h2>
      <RiderLocationIllustration />
      <div className="stack">
        <Button variant="amber" disabled={busy} onClick={async () => { setBusy(true); await browserPosition().catch(() => {}); navigate('/c/', { replace: true }); }}>{copy.allowLocation}</Button>
        <Link className="button button--plain" to="/c/" replace>{copy.riderLocationLater}</Link>
      </div>
    </div> : <div className="rider-pair-success"><span className="success-circle"><Check size={32} /></span><h2>{copy.riderConnected(linked)}</h2><Button onClick={() => setLocationPrompt(true)}>{copy.continue}</Button></div> :
      <form className="rider-pair-form" onSubmit={(event) => { event.preventDefault(); if (ready) void connect(); }}>
        <RiderPairHeading error={error} retrySeconds={retrySeconds} />
        {retrySeconds > 0 && <span className="rider-pair-timer">{String(Math.floor(retrySeconds / 60)).padStart(2, '0')}:{String(retrySeconds % 60).padStart(2, '0')}</span>}
        <CodeInput label={copy.codeLabel} value={code} disabled={busy || retrySeconds > 0} invalid={invalid} highlighted={autofilled && !error} onChange={(value) => { setCode(value); setAutofilled(false); setConsentNeeded(false); setConsent(false); setError(''); }} />
        {consentNeeded && <label className="checkbox"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{copy.consentSelf}</label>}
        {captchaKey && !signedIn && <Captcha key={captchaRevision} siteKey={captchaKey} receive={setCaptcha} />}
        {showInlineError && <p role="alert" className="rider-pair-error danger-text">{error}</p>}
        {autofilled && !error && <p className="small">{copy.codeAutofilled}</p>}
        <Button type="submit" disabled={!ready}>{busy ? copy.loading : copy.connect}</Button>
      </form>}
    {switching && <Sheet title={copy.switchRiderConfirm} close={() => setSwitching(false)} className="rider-prompt-sheet"><p>{copy.switchRiderDesc}</p><Button variant="amber" disabled={busy} onClick={() => { void connect(true); }}>{copy.riderSwitch}</Button><Button variant="secondary" onClick={() => setSwitching(false)}>{copy.riderKeepLink}</Button></Sheet>}
  </div></>;
}

export function PushSettings({ surface, compact = false }: { surface: Surface; compact?: boolean }) {
  const config = useLiveConfig();
  const client = useClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const { run, pending } = useLiveMutation();
  useEffect(() => { void currentSubscription(surface).then((item) => setEnabled(Boolean(item))).catch(() => {}); }, [surface]);
  async function toggle() {
    setBusy(true);
    try {
      if (enabled) await unsubscribePush(client);
      else await subscribePush(client, config.vapidKey);
      setEnabled(!enabled);
    } catch (error) { toast(describeError(error)); }
    finally { setBusy(false); }
  }
  if (surface === 'guardian' && !compact) {
    const installNeeded = isIOS() && !isStandalone();
    return <><MobileHeader title={copy.app} className="guardian-brand-header" back="/p/" />
      <NotificationLayout enabled={enabled} description={!enabled ? copy.notificationDescription : undefined} installHint={!enabled && installNeeded ? copy.pushInstall : undefined}>
        {enabled ? <Button disabled={pending} onClick={() => { void run('enqueue_test_push', {}, copy.testRequested); }}>{copy.notifyTestAction}</Button> : installNeeded ? <Link className="button button--primary" to="/p/install">{copy.installHelp}</Link> : <Button disabled={busy} onClick={() => { void toggle(); }}>{copy.enableNotification}</Button>}
        <Link className="button button--secondary" to="/p/">{enabled ? copy.todayGo : copy.later}</Link>
        {enabled && <Button variant="plain" disabled={busy} onClick={() => { void toggle(); }}>{copy.disableNotification}</Button>}
      </NotificationLayout>
    </>;
  }
  const contents = <div className="stack push-settings"><span className={enabled ? 'success-circle' : 'rider-progress-icon'}>{enabled ? <Check size={31} /> : <Bell size={29} />}</span>
    <h2>{enabled ? copy.notificationEnabled : copy.notificationTitle}</h2><p className="muted">{isIOS() && !isStandalone() ? copy.pushInstall : copy.notificationDescription}</p>
    <Button disabled={busy} onClick={() => { void toggle(); }}>{enabled ? copy.disableNotification : copy.enableNotification}</Button>
    {enabled && surface === 'guardian' && <Button variant="outline" disabled={pending} onClick={() => { void run('enqueue_test_push', {}, copy.testRequested); }}>{copy.testNotification}</Button>}
    {!compact && <Link className="button button--secondary" to={surface === 'rider' ? '/c/' : '/p/'}>{enabled ? copy.todayGo : copy.later}</Link>}
    <Link className="button button--plain" to={surface === 'rider' ? '/c/install' : '/p/install'}>{copy.installHelp}</Link>
  </div>;
  return compact ? contents : <><MobileHeader title={copy.notification} back={surface === 'rider' ? '/c/' : '/p/'} /><div className="mobile-content">{contents}</div></>;
}

export function InvitePanel({ riderId, phone }: { riderId?: string; phone?: string | null }) {
  const client = useClient();
  const toast = useToast();
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const href = invite ? new URL(`${riderId ? '/c/start' : '/p/join'}?code=${encodeURIComponent(invite.code)}`, window.location.origin).href : '';
  useEffect(() => {
    if (!href) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [href]);
  async function generate() {
    setBusy(true);
    try { const result = await client.rpc(riderId ? 'create_rider_invite' : 'create_family_invite', riderId ? { p_rider_id: riderId, p_channel: 'qr' } : {}, inviteSchema); setNow(Date.now()); setInvite(result); }
    catch (error) { toast(describeError(error)); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(href); toast(copy.inviteCopied); } catch { toast(copy.genericError); }
  }
  async function sendSms() {
    if (!riderId || !phone) return;
    setBusy(true);
    try {
      const { data, error } = await client.supabase.functions.invoke('send-rider-invite', { body: { rider_id: riderId } });
      if (error || data?.ok !== true) { toast(copy.smsUnavailable); return; }
      setInvite(null); toast(copy.smsRequested);
    } finally { setBusy(false); }
  }
  async function share() {
    if (!navigator.share) return copyLink();
    try { await navigator.share({ title: copy.app, text: copy.inviteShareText, url: href }); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) void copyLink(); }
  }
  const remaining = invite ? Math.max(0, Math.ceil((Date.parse(invite.expires_at) - now) / 60_000)) : 0;
  return <div className="stack guardian-invite-panel">
    {invite && <>
      {remaining > 0 && <InviteQr href={href} />}
      {riderId && remaining > 0 && <h3 className="guardian-scan-title">{copy.scanRiderQr}</h3>}
      <div className={`guardian-invite-number ${riderId ? 'guardian-rider-code' : ''}`}><p>{riderId ? copy.enterInApp : copy.familyInviteCode}</p><output>{invite.code.replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/, '$1 $2')}</output><span><Clock3 size={18} />{remaining ? copy.inviteTimeRemaining(remaining) : copy.codeTimeOver}</span></div>
      {remaining > 0 && <><Button onClick={() => { void share(); }}>{copy.inviteShare}</Button><Button variant="secondary" onClick={() => { void copyLink(); }}>{copy.inviteCopy}</Button></>}
    </>}
    <Button variant={invite ? 'plain' : 'primary'} disabled={busy} onClick={() => { void generate(); }}>{busy ? copy.loading : invite && !riderId ? copy.makeNewLink : copy.newCode}</Button>
    {riderId && phone && <Button variant="outline" disabled={busy} onClick={() => { void sendSms(); }}>{copy.smsInvite}</Button>}
  </div>;
}

export function Unlinked({ revoked = false }: { revoked?: boolean }) {
  return <><MobileHeader title={copy.app} className="mobile-header--rider" /><div className="mobile-content connection-page rider-pair"><div className="rider-pair-success"><RiderLocationIllustration /><h2>{revoked ? copy.revokedDevice : copy.noDevice}</h2><p className="muted">{copy.requestCode}</p><div className="stack"><Link className="button button--primary" to="/c/link">{copy.connectWithCode}</Link><Link className="button button--plain" to="/c/install">{copy.installHelp}</Link></div></div></div></>;
}
