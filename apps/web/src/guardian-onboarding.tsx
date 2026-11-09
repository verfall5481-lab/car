import { useEffect, useState } from 'react';
import { Clock3, House, Link2, Smartphone } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { copy } from './copy.ts';
import type { DemoState, Person } from './demo-domain.ts';
import { Badge, Button, CodeInput, MobileHeader, Row, Sheet, useToast } from './ui.tsx';

const demoOtp = '248613';
const inviteKey = 'deriro-demo-family-invite';
const initialCode = 'K7Q2M9RT';
const day = 24 * 60 * 60 * 1000;
const codeFormat = /^[A-Z0-9]{8}$/;
const splitCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

type LocalInvite = { code: string; expiresAt: number };
function readDemoInvite(): LocalInvite {
  const fallback = { code: initialCode, expiresAt: Date.now() + day };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(inviteKey) ?? 'null');
    if (typeof raw === 'object' && raw && 'code' in raw && typeof raw.code === 'string' && codeFormat.test(raw.code) && 'expiresAt' in raw && typeof raw.expiresAt === 'number') return { code: raw.code, expiresAt: raw.expiresAt };
  } catch { /* An example invite is sufficient when storage is unavailable. */ }
  return fallback;
}

export function InviteQr({ href, demo = false }: { href: string; demo?: boolean }) {
  const [generated, setGenerated] = useState<{ href: string; data: string }>();
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(href, { width: 192, margin: 2, errorCorrectionLevel: 'M' })
      .then((data) => { if (active) setGenerated({ href, data }); }).catch(() => {});
    return () => { active = false; };
  }, [href]);
  return <figure className="guardian-qr">
    {generated?.href === href && <img src={generated.data} width="160" height="160" alt={demo ? copy.demoQrLabel : copy.inviteQr} />}
    <figcaption>{demo ? copy.demoQrLabel : copy.inviteQr}</figcaption>
  </figure>;
}

export function FamilyChoices({ create }: { create: () => void }) {
  return <div className="mobile-content guardian-account guardian-account--choices">
    <div className="guardian-account-intro"><h2>{copy.setupFamily}</h2><p className="muted">{copy.setupFamilyDescription}</p></div>
    <div className="guardian-choice-list">
      <Row icon={<House size={25} />} title={copy.newFamily} caption={copy.newFamilyHint} onClick={create} />
      <Row icon={<Link2 size={25} />} title={copy.invited} caption={copy.invitedHint} to="/p/join" />
    </div>
  </div>;
}

export function NicknameOptions({ name, choose }: { name: string; choose: (name: string) => void }) {
  return <div className="guardian-nickname-options chips">{copy.nicknameOptions.map((nickname) => <button key={nickname} type="button" className="chip" aria-pressed={name === nickname} onClick={() => choose(nickname)}><span aria-hidden="true" />{nickname}</button>)}</div>;
}

export function DemoGuardianLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>(copy.emailExample);
  const [token, setToken] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [error, setError] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (step !== 'code') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);
  function resend() { const stamp = Date.now(); setNow(stamp); setResendAt(stamp + 60_000); }
  return <><MobileHeader title={copy.app} back={step === 'email' ? '/p/demo' : undefined} className="guardian-brand-header" />
    <div className="mobile-content guardian-account">
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        if (step === 'email') { setStep('code'); resend(); return; }
        if (token === demoOtp) navigate('/p/onboarding');
        else setError(true);
      }}>
        <div className="guardian-account-intro"><h2>{step === 'email' ? copy.loginTitle : copy.otpTitle}</h2><p className="muted">{step === 'email' ? copy.loginDescription : copy.demoLoginHint}</p></div>
        {step === 'email' ? <>
          <label className="field">{copy.email}<input type="email" value={email} required onChange={(event) => setEmail(event.target.value)} placeholder={copy.emailExample} /></label>
          <Button type="submit" disabled={!email.trim()}>{copy.getOtp}</Button>
          <div className="guardian-account-help"><Smartphone size={28} /><div><p>{copy.iosInstallLogin}</p><Link to="/p/install">{copy.installHelp}</Link></div></div>
          <p className="small muted guardian-demo-note"><Badge tone="neutral">{copy.demo}</Badge> {copy.demoLoginHint}</p>
        </> : <>
          <p>{email}</p><CodeInput label={copy.otpTitle} length={6} value={token} invalid={error} onChange={(value) => { setToken(value); setError(false); }} />
          {error && <p role="alert" className="danger-text">{copy.otpInvalid}</p>}
          <p className="guardian-demo-code" role="status">{copy.demoOtpHint} <strong>{demoOtp}</strong></p>
          <Button type="submit" disabled={token.length !== 6}>{copy.confirm}</Button>
          <Button variant="secondary" disabled={resendAt > now} onClick={() => { setToken(''); setError(false); resend(); }}>{copy.resend}{resendAt > now ? ` ${resendAt - now > 59_000 ? '01:00' : `00:${String(Math.ceil((resendAt - now) / 1000)).padStart(2, '0')}`}` : ''}</Button>
          <Button variant="plain" onClick={() => { setStep('email'); setToken(''); setError(false); }}>{copy.changeEmail}</Button>
        </>}
      </form>
    </div>
  </>;
}

export function DemoGuardianInstall() {
  return <><MobileHeader title={copy.app} back="/p/login" className="guardian-brand-header" /><div className="mobile-content guardian-account">
    <div className="guardian-account-intro"><h2>{copy.iosInstallLogin}</h2><p className="muted">{copy.pushInstall}</p></div>
    <ol className="guardian-install-steps"><li>{copy.shareButton}</li><li>{copy.addHome}</li><li>{copy.openHome}</li></ol>
    <Link className="button button--primary" to="/p/login">{copy.browserContinue}</Link>
  </div></>;
}

export function DemoFamilySetup({ state, member, join = false }: { state: DemoState; member: Person; join?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const showForm = join || params.get('profile') === '1';
  const [invite] = useState(readDemoInvite);
  const [code, setCode] = useState(() => normalizeCode(params.get('code') ?? ''));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [sms, setSms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const ready = code === invite.code && invite.expiresAt > Date.now();
  return <><MobileHeader title={copy.app} className="guardian-brand-header" back={showForm ? '/p/onboarding' : '/p/demo'} />
    {!showForm ? <FamilyChoices create={() => navigate('/p/onboarding?profile=1')} /> : <div className="mobile-content guardian-account">
      <form className="stack" onSubmit={(event) => { event.preventDefault(); navigate('/p/notifications'); }}>
        <div className="guardian-account-intro">
          <h2>{join ? ready ? copy.joinPreview(member.name) : copy.joinTitle : copy.info}</h2>
          <p className="muted">{join ? ready ? state.familyName : copy.demoJoinHint : copy.setupProfileDescription}</p>
        </div>
        {join && <label className="field guardian-invite-code">{copy.familyInviteCode}<input autoComplete="off" value={code} maxLength={9} placeholder={splitCode(invite.code)} onChange={(event) => setCode(normalizeCode(event.target.value))} /></label>}
        <div className="stack guardian-name-fields">
          <label className="field">{copy.guardianNickname}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={20} placeholder={copy.namePlaceholder} /></label>
          <NicknameOptions name={name} choose={setName} /><p className="small muted">{copy.guardianNicknameHint}</p>
        </div>
        <label className="field">{copy.phone}<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={22} placeholder={copy.phoneFormat} /></label>
        <label className="checkbox guardian-approval"><input type="checkbox" checked={sms} disabled={!phone.trim()} onChange={(event) => setSms(event.target.checked)} />{copy.messageNotification}</label>
        <div className="guardian-consent"><label className="checkbox guardian-approval"><input type="checkbox" checked={consent} required onChange={(event) => setConsent(event.target.checked)} />{copy.privacyConsent}</label><Button variant="plain" onClick={() => setPrivacy(true)} aria-label={copy.privacyPolicy}>{copy.viewFull}</Button></div>
        <Button type="submit" disabled={!name.trim() || !consent || join && !ready}>{join ? copy.joinFamily : copy.newFamily}</Button>
        {join && <p className="guardian-install-tip"><Smartphone size={19} />{copy.continueAfterInstall}</p>}
        <p className="small muted guardian-demo-note">{copy.demoSetupHint}</p>
      </form>
      {privacy && <Sheet title={copy.privacyPolicy} close={() => setPrivacy(false)}><p>{copy.privacyDetails}</p><Button onClick={() => setPrivacy(false)}>{copy.close}</Button></Sheet>}
    </div>}
  </>;
}

export function DemoGuardianInvite() {
  const [invite, setInvite] = useState(readDemoInvite);
  const [now, setNow] = useState(Date.now);
  const toast = useToast();
  const href = new URL(`/p/join?code=${invite.code}`, window.location.origin).href;
  const timeLeft = Math.max(0, Math.ceil((invite.expiresAt - now) / 60_000));
  useEffect(() => {
    try { if (localStorage.getItem(inviteKey) == null) localStorage.setItem(inviteKey, JSON.stringify(invite)); } catch { /* Keep the example visible. */ }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invite]);
  function regenerate() {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (part) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[part % 32]).join('');
    const stamp = Date.now();
    const next = { code, expiresAt: stamp + day };
    try { localStorage.setItem(inviteKey, JSON.stringify(next)); }
    catch { toast(copy.genericError); return; }
    setNow(stamp); setInvite(next);
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(href); toast(copy.inviteCopied); } catch { toast(copy.genericError); }
  }
  async function share() {
    if (!navigator.share) return copyLink();
    try { await navigator.share({ title: copy.demoQrLabel, url: href }); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) void copyLink(); }
  }
  return <><MobileHeader title={copy.app} back="/p/family" className="guardian-brand-header" />
    <div className="mobile-content guardian-account guardian-invite-page">
      <h2>{copy.guardianInvite}</h2>
      {timeLeft > 0 && <InviteQr href={href} demo />}
      <div className="guardian-invite-number"><p>{copy.familyInviteCode}</p><output>{splitCode(invite.code)}</output><span><Clock3 size={18} />{timeLeft ? copy.inviteTimeRemaining(timeLeft) : copy.codeTimeOver}</span></div>
      <div className="stack guardian-invite-actions">
        {timeLeft > 0 && <><Button onClick={() => { void share(); }}>{copy.inviteShare}</Button><Button variant="secondary" onClick={() => { void copyLink(); }}>{copy.inviteCopy}</Button></>}
        <Button variant="plain" onClick={regenerate}>{copy.makeNewLink}</Button>
        <p className="small muted guardian-demo-note">{copy.demoJoinHint}</p>
      </div>
    </div>
  </>;
}
