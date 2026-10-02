import { redirect } from "next/navigation";

/**
 * "Train BARRY" became two Owner OS pages: what BARRY knows (/owner/knowledge) and BARRY setup
 * (/owner/setup). Links already sent keep working: a rule typed into the command bar (?rule=…) goes to
 * Rules BARRY follows, where it is taught through the same reviewed path.
 */
export default async function TrainRedirect({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const rule = (await searchParams).rule;
  if (typeof rule === "string" && rule.trim()) redirect(`/owner/rules?rule=${encodeURIComponent(rule)}`);
  redirect("/owner/setup");
}
