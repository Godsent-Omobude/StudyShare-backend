import prisma from "../config/prisma.js";

// Generates the next sequential case number for the current calendar year,
// e.g. "CR-2026-0001", "CR-2026-0002", ... A new sequence starts each year.
//
// Concurrency: rather than a separate counter table, we read the highest
// existing case number for the year and retry on a unique-constraint
// collision (Prisma error code P2002) — safe under the low write volume of
// an admin-only tool, and self-healing if two admins create a case in the
// same instant.
export async function generateCaseNumber() {
  const year = new Date().getFullYear();
  const prefix = `CR-${year}-`;

  const last = await prisma.copyrightReport.findFirst({
    where: { caseNumber: { startsWith: prefix } },
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });

  const lastSeq = last ? parseInt(last.caseNumber.slice(prefix.length), 10) || 0 : 0;
  return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
}

// Wraps a CopyrightReport creation with automatic case-number retry, in
// case of a rare race between two concurrent case creations.
export async function createCopyrightReportWithCaseNumber(data, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const caseNumber = await generateCaseNumber();
    try {
      return await prisma.copyrightReport.create({ data: { ...data, caseNumber } });
    } catch (error) {
      const isCaseNumberCollision = error?.code === "P2002" && error?.meta?.target?.includes("caseNumber");
      if (!isCaseNumberCollision || attempt === tries - 1) throw error;
      // Someone else grabbed that number a moment ago — loop and try the next one.
    }
  }
  throw new Error("Unable to generate a unique case number.");
}
