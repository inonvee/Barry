"use client";

type BusinessSummary = { id: string; name: string; description: string };

export function BusinessSwitcher({
  businesses,
  activeId,
  onSelect,
}: {
  businesses: BusinessSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {businesses.map((b) => (
        <button
          key={b.id}
          onClick={() => onSelect(b.id)}
          className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
            activeId === b.id
              ? "bg-indigo-600 text-white"
              : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          }`}
        >
          {b.name}
        </button>
      ))}
    </div>
  );
}
