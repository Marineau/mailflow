import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  estimate,
  forgetProgress,
  readCheckpoint,
  recordDuration,
  type Checkpoint,
  type ProgressKind,
} from '../lib/progress';

type Phase = 'idle' | 'running' | 'finishing';

/** Time to run the fill to the end once the action is over, then to fade it. */
const COMPLETE_MS = 260;
const FADE_MS = 420;

/**
 * The fill drawn behind a button's label while its action runs. Place it as
 * the first child of a button carrying `mf-filling` (positioning, clipping,
 * stacking: index.css); each theme draws `.mf-fill` its own way, reading the
 * level from `--mf-fill` (0 to 1).
 *
 * The level is written straight onto the element from an animation frame
 * loop: re-rendering the button 60 times a second would re-render whatever
 * holds it (the composer and its editor).
 */
export default function ProgressFill({
  op,
  running,
  kind,
}: {
  /** Key of the checkpoints to follow (lib/progress.ts). */
  op: string | null;
  running: boolean;
  kind: ProgressKind;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const element = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const startedAt = useRef(0);
  const origin = useRef<{ at: number; t: number } | null>(null);
  const opRef = useRef(op);
  opRef.current = op;

  if (running && phase !== 'running') {
    shown.current = 0;
    startedAt.current = performance.now();
    origin.current = null;
    setPhase('running');
  } else if (!running && phase === 'running') {
    setPhase('finishing');
  }

  useLayoutEffect(() => {
    element.current?.style.setProperty('--mf-fill', shown.current.toFixed(4));
  });

  useEffect(() => {
    if (phase !== 'running') return;
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      const key = opRef.current;
      const real = key ? readCheckpoint(key) : undefined;
      // No checkpoint yet: one step from 0, ending short of full.
      const checkpoint: Checkpoint = real ?? { at: 0, next: 0.9, t: startedAt.current };
      if (!origin.current) {
        // A job found already under way (indexing resumed at start-up) is
        // timed from its first checkpoint, not from 0 at mount.
        origin.current =
          real && real.at > 0.05 ? { at: real.at, t: real.t } : { at: 0, t: startedAt.current };
        if (real && real.at > 0.05) shown.current = real.at;
      }
      const level = Math.max(shown.current, estimate(checkpoint, origin.current, kind, now));
      shown.current = Math.min(level, 1);
      element.current?.style.setProperty('--mf-fill', shown.current.toFixed(4));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, kind]);

  useEffect(() => {
    if (phase !== 'finishing') return;
    const key = opRef.current;
    recordDuration(kind, performance.now() - startedAt.current);
    if (key) forgetProgress(key);

    const from = shown.current;
    const begin = performance.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - begin) / COMPLETE_MS);
      shown.current = from + (1 - from) * (1 - (1 - t) ** 3);
      element.current?.style.setProperty('--mf-fill', shown.current.toFixed(4));
      if (t < 1) frame = requestAnimationFrame(tick);
      else element.current?.setAttribute('data-state', 'done');
    };
    frame = requestAnimationFrame(tick);
    const timer = window.setTimeout(() => setPhase('idle'), COMPLETE_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [phase, kind]);

  if (phase === 'idle') return null;
  return <span ref={element} aria-hidden className="mf-fill" data-kind={kind} />;
}
