import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EDIT_PLAN_VERSION, EditPlanError } from "../types.ts";
import { validateEditPlan } from "../validate.ts";

const SOURCE_DURATION = 120;

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: EDIT_PLAN_VERSION,
    jobId: "job-001",
    clips: [{ id: "clip-1", start: 10, end: 25 }],
    ...overrides,
  };
}

function validate(raw: unknown, options: Record<string, unknown> = {}) {
  return validateEditPlan(raw, { sourceDuration: SOURCE_DURATION, ...options });
}

/** Runs validation and returns the collected issue list. */
function issuesFrom(raw: unknown, options: Record<string, unknown> = {}): string[] {
  try {
    validate(raw, options);
  } catch (error) {
    assert.ok(error instanceof EditPlanError, `expected EditPlanError, got ${String(error)}`);
    return error.issues;
  }
  assert.fail("expected validation to fail");
}

describe("validateEditPlan", () => {
  it("accepts a well-formed plan and applies framing defaults", () => {
    const result = validate(plan());

    assert.equal(result.jobId, "job-001");
    assert.equal(result.sourceDuration, SOURCE_DURATION);
    assert.equal(result.clips.length, 1);
    assert.deepEqual(result.clips[0]?.framing, { mode: "crop", centerX: 0.5 });
  });

  it("keeps optional title and reason, dropping empty strings", () => {
    const result = validate(
      plan({ clips: [{ id: "c1", start: 0, end: 10, title: "The good bit", reason: "" }] }),
    );

    assert.equal(result.clips[0]?.title, "The good bit");
    assert.equal(result.clips[0]?.reason, undefined);
  });

  it("takes the source duration from ingest, not from the plan", () => {
    // A model claiming the video is an hour long must not widen what it can cut.
    const result = validate(plan({ sourceDuration: 3600 }));

    assert.equal(result.sourceDuration, SOURCE_DURATION);
  });

  it("reports every problem at once so a retry can fix them together", () => {
    const issues = issuesFrom(
      plan({
        version: 99,
        jobId: "not a valid id",
        clips: [
          { id: "c1", start: -5, end: 10 },
          { id: "c2", start: 50, end: 40 },
        ],
      }),
    );

    assert.ok(issues.length >= 3, `expected several issues, got ${JSON.stringify(issues)}`);
    assert.ok(issues.some((issue) => issue.includes("version")));
    assert.ok(issues.some((issue) => issue.includes("jobId")));
  });

  it("clamps a clip that slightly overshoots the end of the source", () => {
    const result = validate(plan({ clips: [{ id: "c1", start: 100, end: SOURCE_DURATION + 0.3 }] }));

    assert.equal(result.clips[0]?.end, SOURCE_DURATION);
  });

  it("rejects a clip that overshoots well past the end", () => {
    const issues = issuesFrom(plan({ clips: [{ id: "c1", start: 100, end: SOURCE_DURATION + 30 }] }));

    assert.ok(issues.some((issue) => issue.includes("beyond the source duration")));
  });

  it("rejects a clip starting past the end of the source", () => {
    const issues = issuesFrom(plan({ clips: [{ id: "c1", start: 500, end: 510 }] }));

    assert.ok(issues.some((issue) => issue.includes("beyond the source duration")));
  });

  it("rejects timestamps that are not finite numbers", () => {
    for (const bad of ["10", null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const issues = issuesFrom(plan({ clips: [{ id: "c1", start: bad, end: 30 }] }));
      assert.ok(
        issues.some((issue) => issue.includes("finite numbers")),
        `expected a finite-number issue for ${String(bad)}`,
      );
    }
  });

  it("rejects an end at or before the start", () => {
    const issues = issuesFrom(plan({ clips: [{ id: "c1", start: 30, end: 30 }] }));
    assert.ok(issues.some((issue) => issue.includes("must be greater than start")));
  });

  it("enforces the minimum clip duration", () => {
    const issues = issuesFrom(plan({ clips: [{ id: "c1", start: 10, end: 11 }] }));
    assert.ok(issues.some((issue) => issue.includes("under the 3s minimum")));
  });

  it("enforces the maximum clip duration", () => {
    const issues = issuesFrom(plan({ clips: [{ id: "c1", start: 0, end: 100 }] }));
    assert.ok(issues.some((issue) => issue.includes("exceeds the 90s maximum")));
  });

  it("honours overridden constraints", () => {
    const result = validate(plan({ clips: [{ id: "c1", start: 10, end: 11 }] }), {
      constraints: { minDurationSeconds: 0.5 },
    });

    assert.equal(result.clips.length, 1);
  });

  it("rejects duplicate clip IDs", () => {
    const issues = issuesFrom(
      plan({
        clips: [
          { id: "same", start: 0, end: 10 },
          { id: "same", start: 20, end: 30 },
        ],
      }),
    );

    assert.ok(issues.some((issue) => issue.includes("duplicate id")));
  });

  it("rejects more clips than the maximum", () => {
    const clips = Array.from({ length: 25 }, (_, index) => ({
      id: `c${index}`,
      start: index,
      end: index + 4,
    }));

    assert.ok(issuesFrom(plan({ clips })).some((issue) => issue.includes("over the 20 maximum")));
  });

  it("rejects an empty clip list", () => {
    assert.ok(issuesFrom(plan({ clips: [] })).some((issue) => issue.includes("at least one clip")));
  });

  it("rejects clips that are not an array", () => {
    assert.ok(issuesFrom(plan({ clips: "clip-1" })).some((issue) => issue.includes("must be an array")));
  });

  it("rejects a plan that is not an object", () => {
    for (const bad of [null, "plan", 42, []]) {
      assert.throws(() => validate(bad), EditPlanError);
    }
  });

  it("rejects a plan naming a different job", () => {
    const issues = issuesFrom(plan(), { jobId: "job-002" });
    assert.ok(issues.some((issue) => issue.includes("does not match the job being processed")));
  });

  it("rejects a clip ID that could reshape a storage key", () => {
    assert.ok(issuesFrom(plan({ clips: [{ id: "../../etc", start: 0, end: 10 }] })).length > 0);
  });

  describe("framing", () => {
    it("accepts pad mode", () => {
      const result = validate(plan({ clips: [{ id: "c1", start: 0, end: 10, framing: { mode: "pad" } }] }));
      assert.equal(result.clips[0]?.framing?.mode, "pad");
    });

    it("accepts an explicit centerX", () => {
      const result = validate(
        plan({ clips: [{ id: "c1", start: 0, end: 10, framing: { mode: "crop", centerX: 0.25 } }] }),
      );
      assert.equal(result.clips[0]?.framing?.centerX, 0.25);
    });

    it("rejects an unknown framing mode", () => {
      const issues = issuesFrom(
        plan({ clips: [{ id: "c1", start: 0, end: 10, framing: { mode: "zoom" } }] }),
      );
      assert.ok(issues.some((issue) => issue.includes("framing.mode")));
    });

    it("rejects centerX outside 0..1", () => {
      for (const bad of [-0.1, 1.5, "0.5"]) {
        const issues = issuesFrom(
          plan({ clips: [{ id: "c1", start: 0, end: 10, framing: { centerX: bad } }] }),
        );
        assert.ok(issues.some((issue) => issue.includes("centerX")), `expected issue for ${String(bad)}`);
      }
    });
  });

  it("rejects a non-positive source duration outright", () => {
    assert.throws(() => validateEditPlan(plan(), { sourceDuration: 0 }), EditPlanError);
  });
});
