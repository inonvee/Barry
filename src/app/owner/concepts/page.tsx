"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useOwnerApi } from "@/components/owner/useOwnerApi";
import type { OwnerWorkspace } from "@/lib/owner/service";
import { ConceptA, ConceptB, ConceptC } from "./concepts";

/**
 * ART-DIRECTION EXPLORATION — three concepts for TODAY only, rendered from the same real workspace the
 * product reads (owner session required). Not linked anywhere; nothing here is the product yet.
 */
export default function ConceptsPage() {
  return (
    <Suspense fallback={null}>
      <Concepts />
    </Suspense>
  );
}

function Concepts() {
  const params = useSearchParams();
  const which = params.get("c") ?? "a";
  const { businessId, call, authorized } = useOwnerApi();
  const [ws, setWs] = useState<OwnerWorkspace | null>(null);
  const [asOf, setAsOf] = useState<Date | null>(null);
  useEffect(() => {
    if (!authorized || !businessId) return;
    call<OwnerWorkspace>(`/api/owner/workspace?businessId=${encodeURIComponent(businessId)}&window=today&lang=en`).then((w) => {
      setWs(w);
      setAsOf(new Date());
    });
  }, [authorized, businessId, call]);
  if (!ws || !asOf) return <div className="min-h-screen bg-white" />;
  if (which === "b") return <ConceptB ws={ws} now={asOf} />;
  if (which === "c") return <ConceptC ws={ws} now={asOf} />;
  return <ConceptA ws={ws} now={asOf} />;
}
