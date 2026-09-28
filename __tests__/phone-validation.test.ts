import { describe, expect, it } from "vitest";
import { buildSpaGraph } from "@/lib/fixtures/spa";
import { normalizeCustomerInfoField } from "@/lib/reasoner/customer-fields";
import { runScenario } from "./support/eval-harness";

describe("Phone validation", () => {
  it("rejects clearly incomplete phone numbers before persistence", () => {
    expect(normalizeCustomerInfoField("phone", "05588321")).toBeUndefined();
    expect(normalizeCustomerInfoField("phone", "12345678")).toBeUndefined();
  });

  it("keeps valid local, Israeli, and international phone formats", () => {
    expect(normalizeCustomerInfoField("phone", "0558832177")).toBe("0558832177");
    expect(normalizeCustomerInfoField("phone", "057484848")).toBe("057484848");
    expect(normalizeCustomerInfoField("phone", "054-123-4567")).toBe("054-123-4567");
    expect(normalizeCustomerInfoField("phone", "+972558832177")).toBe("+972558832177");
    expect(normalizeCustomerInfoField("phone", "555-111-2222")).toBe("555-111-2222");
  });

  it("English incomplete phone input is not persisted and phone remains missing", async () => {
    const { state, turns } = await runScenario({
      name: "phone-invalid-en",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "My name is Inon and my phone is 05588321" },
      ],
    });

    expect(turns[1].compiled?.appliedCustomerInfo).toEqual({ name: "Inon" });
    expect(state.knownFields.phone).toBeUndefined();
    expect(state.missingFields).toContain("phone");
    expect(turns[1].response.toLowerCase()).toMatch(/phone/);
  });

  it("Hebrew incomplete phone input is not persisted and phone remains missing", async () => {
    const { state, turns } = await runScenario({
      name: "phone-invalid-he",
      graph: buildSpaGraph,
      turns: [
        { customer: "Couples massage Tuesday at 3pm" },
        { customer: "השם שלי ינון והטלפון שלי 05588321" },
      ],
    });

    expect(turns[1].compiled?.appliedCustomerInfo).toEqual({ name: "ינון" });
    expect(state.knownFields.phone).toBeUndefined();
    expect(state.missingFields).toContain("phone");
    expect(turns[1].response.toLowerCase()).toMatch(/phone/);
  });
});
