import React from 'react';
import type {SceneId} from '../timing';
import {OpenScene} from './OpenScene';
import {VerifyScene} from './VerifyScene';
import {BrandScene} from './BrandScene';
import {OperateScene} from './OperateScene';
import {SupplierScene} from './SupplierScene';
import {OwnerScene} from './OwnerScene';
import {ScaleScene} from './ScaleScene';
import {AuthorityScene} from './AuthorityScene';

const Todo: React.FC = () => <div style={{background: '#050506', width: '100%', height: '100%'}} />;

export const SCENES: Record<SceneId, React.FC> = {
  open: OpenScene,
  verify: VerifyScene,
  operate: OperateScene,
  authority: AuthorityScene,
  supplier: SupplierScene,
  owner: OwnerScene,
  scale: ScaleScene,
  brand: BrandScene,
};
