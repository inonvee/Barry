import { Skeleton } from "@/components/ds/primitives";

/** Shown the moment an HQ page is opened while its server read runs (fleet / commercial reads take seconds). */
export default function HqLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10" role="status" aria-live="polite">
      <p className="mb-4 text-sm font-medium text-[#475467]">Loading from HQ records…</p>
      <Skeleton lines={4} />
    </div>
  );
}
