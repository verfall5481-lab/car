// 24장 갈 사람이 없을 때: the pieces the rider and guardian screens share. Decision logic lives in guardian-view.ts.
import { useEffect, useState } from 'react';
import { ChevronRight, Info } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { fallbackNoteText } from '@deriro/contracts';
import type { Pickup } from '@deriro/contracts';
import { clock, copy, dayLabel, dayWeekday, shortDay } from './copy.ts';
import { nameOf, unavailableOnDay } from './demo-domain.ts';
import type { DemoState, Person } from './demo-domain.ts';
import { driverGaps, fallbackOptions, unavailableGrid, waitNoteFor } from './guardian-view.ts';
import { Button, MobileHeader, RadioLine, Row, Sheet, useClock, usePickupOperations } from './ui.tsx';

/** The amber box with a small label and a large line (24.5), shaped like C-01's number box. */
export function NoteBox({ label, text }: { label: string; text: string }) {
  return <div className="note-box"><span>{label}</span><strong>{text}</strong></div>;
}

/** P-18 "못 간다고 알리기": the line the requester should follow instead, then the declaration itself. */
export function NoDriverSheet({ state, pickup, close, confirm }: { state: DemoState; pickup: Pickup; close: () => void; confirm: (note: string) => Promise<void> }) {
  const name = nameOf(state, pickup.requester.id);
  const placeNote = waitNoteFor(state, pickup);
  const placeLabel = pickup.destination.placeId ? state.places.find((place) => place.id === pickup.destination.placeId)?.label : undefined;
  const options = fallbackOptions(placeNote, copy.fallbackPresets);
  const own = 'own';
  const [choice, setChoice] = useState(options[0].note);
  const [text, setText] = useState('');
  const pending = usePickupOperations()?.pending;
  const note = choice === own ? fallbackNoteText(text) : choice;
  return <Sheet title={copy.noDriverQuestion(name)} close={close} className="no-driver-sheet">
    <p className="small muted no-driver-sheet-when">{clock(pickup.wantedAt)} {placeLabel ?? pickup.destination.label}</p>
    <fieldset className="no-driver-sheet-choices"><legend>{copy.insteadTitle}</legend>
      {options.map((option) => <RadioLine key={option.note} name="instead" value={option.note} selected={choice} change={setChoice} label={option.note}
        hint={option.place && placeLabel ? copy.placeNoteHint(placeLabel) : undefined} />)}
      <RadioLine name="instead" value={own} selected={choice} change={setChoice} label={copy.writeOwn} />
      {choice === own && <label className="field guardian-note"><input aria-label={copy.writeOwn} value={text} maxLength={40} autoFocus onChange={(event) => setText(event.target.value)} /><span aria-hidden="true">{text.length}/40</span></label>}
    </fieldset>
    <p className="small muted place-meta"><Info size={17} />{copy.noDriverInfo(name)}</p>
    <div className="stack sheet-actions"><Button disabled={pending || !note} onClick={() => { if (note) void confirm(note); }}>{copy.declareNoDriver}</Button>
      <Button variant="plain" onClick={close}>{copy.back}</Button></div>
  </Sheet>;
}

/** P-13 "못 갈 때 안내 (선택)": a preset chip fills the line; the place keeps it for the requester's screen. */
export function PlaceFallbackField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <fieldset className="place-fallback"><legend>{copy.placeFallbackLabel}</legend>
    <div className="chips">{copy.fallbackPresets.map((item) => <button key={item} type="button" className="chip chip--small" aria-pressed={value === item} onClick={() => onChange(item)}>{item}</button>)}</div>
    <label className="field guardian-note"><input aria-label={copy.placeFallbackLabel} value={value} maxLength={40} onChange={(event) => onChange(event.target.value)} /><span aria-hidden="true">{value.length}/40</span></label>
    <p className="small muted">{copy.placeFallbackHelp}</p>
  </fieldset>;
}

export type DayToggle = (day: string, unavailable: boolean) => Promise<{ ok: boolean; held: number }>;

/**
 * P-19 못 가는 날 (`/p/unavailable`). Each cell toggles one of my days and saves at once; a failed save puts the cell
 * back (the caller shows the error). Other guardians' days show as the first letter of their name, read only.
 */
export function UnavailablePage({ state, member, toggle }: { state: DemoState; member: Person; toggle: DayToggle }) {
  const now = useClock(state);
  const location = useLocation();
  const back = typeof location.state?.from === 'string' && location.state.from.startsWith('/p/') ? location.state.from : '/p/routines';
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [held, setHeld] = useState(0);
  const days = unavailableGrid(now);
  const stored = (day: string) => unavailableOnDay(state, day).includes(member.id);
  const mine = (day: string) => overrides[day] ?? stored(day);
  const canMark = member.canDrive && member.leftAt == null;
  const others = (day: string) => unavailableOnDay(state, day).filter((id) => id !== member.id).map((id) => nameOf(state, id)).filter(Boolean);
  const gaps = driverGaps(state, now);
  const daysKey = JSON.stringify(state.unavailableDays ?? []);
  // Once the saved days agree with a pressed cell, the cell follows the saved days again.
  useEffect(() => {
    setOverrides((current) => Object.fromEntries(Object.entries(current).filter(([day, value]) => stored(day) !== value)));
  }, [daysKey]);
  async function press(day: string) {
    const next = !mine(day);
    setOverrides((current) => ({ ...current, [day]: next }));
    const result = await toggle(day, next);
    if (!result.ok) setOverrides((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== day)));
    else setHeld(next ? result.held : 0);
  }
  return <><MobileHeader title={copy.unavailableTitle} back={back} className="guardian-detail-header" />
    <div className="mobile-content unavailable-page">
      <p className="muted">{copy.unavailableIntro}</p>
      {!canMark && <p className="guardian-form-tip"><Info size={18} />{copy.unavailableNoDrive}</p>}
      <div className="unavailable-grid">
        {days.slice(0, 7).map((day) => <span key={`label-${day}`} className="unavailable-weekday" aria-hidden="true">{dayWeekday(day)}</span>)}
        {days.map((day) => {
          const names = others(day);
          return <div key={day} className="unavailable-cell">
            <button type="button" className="unavailable-day" aria-pressed={mine(day)} disabled={!canMark}
              aria-label={[dayLabel(day), names.length ? copy.unavailableOthers(names.join(', ')) : ''].filter(Boolean).join(', ')}
              onClick={() => { void press(day); }}>{Number(day.slice(8))}</button>
            <span className="unavailable-others" aria-hidden="true">{names.map((item) => item[0]).join('')}</span>
          </div>;
        })}
      </div>
      {gaps.length > 0 && <section className="schedule unavailable-gaps"><h2>{copy.unavailableNeeds}</h2>
        {gaps.map((gap) => {
          const title = copy.unavailableRow(shortDay(gap.day), gap.routine.time, nameOf(state, gap.routine.requester.id), state.places.find((place) => place.id === gap.routine.placeId)?.label ?? copy.location);
          const caption = <span className={gap.nobody ? 'danger-text' : undefined}>{gap.nobody ? copy.tomorrowNobody : copy.unavailableDefault(nameOf(state, gap.routine.assigneeId))}</span>;
          return gap.pickup ? <Row key={`${gap.routine.id}-${gap.day}`} title={title} caption={caption} to={`/p/pickups/${gap.pickup.id}`} /> :
            <Row key={`${gap.routine.id}-${gap.day}`} title={title} caption={caption} />;
        })}
      </section>}
      <p className="small muted place-meta unavailable-held" aria-live="polite">{held > 0 && <><Info size={17} />{copy.unavailableHeld(held)}</>}</p>
    </div>
  </>;
}

/** The text link into P-19 from P-04's "내일" cards and P-08. */
export function UnavailableLink({ from }: { from: string }) {
  return <Link className="guardian-text-link" to="/p/unavailable" state={{ from }}>{copy.unavailableTitle}<ChevronRight aria-hidden="true" size={15} /></Link>;
}
