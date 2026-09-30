import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentation, TransitionPresentationComponentProps} from '@remotion/transitions';
import {EASE} from './motion';

type Props = {push?: number};

/** "Focus pull": the outgoing world defocuses and recedes while the next one racks into focus. Blur + scale, no wipes. */
const FocusPullComponent: React.FC<TransitionPresentationComponentProps<Props>> = ({children, presentationDirection, presentationProgress, passedProps}) => {
  const push = passedProps.push ?? 0.06;
  const p = EASE.inOut(presentationProgress);
  const entering = presentationDirection === 'entering';
  const opacity = entering ? Math.min(1, p * 1.5) : 1 - Math.min(1, p * 1.25);
  const blur = entering ? (1 - p) * 26 : p * 26;
  const scale = entering ? 1 - push * (1 - p) : 1 + push * p;
  return (
    <AbsoluteFill style={{opacity, filter: blur > 0.3 ? `blur(${blur}px)` : undefined, scale}}>
      {children}
    </AbsoluteFill>
  );
};

export const focusPull = (props: Props = {}): TransitionPresentation<Props> => ({component: FocusPullComponent, props});
