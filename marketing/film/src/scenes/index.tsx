import React from 'react';
import type {SceneId} from '../timing';
import {MorningScene} from './MorningScene';
import {DressScene} from './DressScene';
import {PatienceScene} from './PatienceScene';
import {Close5Scene} from './Close5Scene';
import {EscalateScene} from './EscalateScene';
import {OwnerScene} from './OwnerScene';
import {SupplierScene} from './SupplierScene';
import {MontageScene} from './MontageScene';
import {SystemsScene} from './SystemsScene';
import {AdaptScene} from './AdaptScene';
import {NightScene} from './NightScene';
import {NextDayScene} from './NextDayScene';
import {BrandScene} from './BrandScene';

export const SCENES: Record<SceneId, React.FC> = {
  morning: MorningScene,
  dress: DressScene,
  patience: PatienceScene,
  close5: Close5Scene,
  escalate: EscalateScene,
  owner: OwnerScene,
  supplier: SupplierScene,
  montage: MontageScene,
  systems: SystemsScene,
  adapt: AdaptScene,
  night: NightScene,
  nextDay: NextDayScene,
  brand: BrandScene,
};
