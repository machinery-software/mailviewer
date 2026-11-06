// The release commands' pure parts (scripts/release.mjs): how a version is
// tagged and described, and the MATCH / BEHIND decision, against JSON in the
// shape wrangler 4.148 prints for `deployments status`, `versions view` and
// `versions list` (recorded from the mailviewer Worker on 6 November 2026).
// Nothing here runs git or wrangler.
import { describe, expect, it } from "vitest";
import {
  // @ts-expect-error -- a plain .mjs script, no type declarations
  MESSAGE_LIMIT, decide, deployArgs, describeVersion, liveVersions, sameCommit, shaFromMessage, stagingVersion, statusReport, uploadArgs, versionLine, versionMessage, versionTag,
} from "./release.mjs";

/** `wrangler deployments status --json`, one version at 100%. */
const DEPLOYMENT = {
  id: "b2a32673-b349-47b6-b4c7-6eef32cf04b8",
  source: "wrangler",
  strategy: "percentage",
  author_email: "someone@example.com",
  annotations: { "workers/message": "", "workers/triggered_by": "deployment" },
  versions: [{ version_id: "457f5dc1-b223-4034-8c89-70d8da9f4ef4", percentage: 100 }],
  created_on: "2026-11-06T14:50:29.565513Z",
};
/** `wrangler versions view <id> --json`, as versions were labelled before this change: the sha only, in the message. */
const UNTAGGED = {
  id: "457f5dc1-b223-4034-8c89-70d8da9f4ef4",
  number: 24,
  metadata: { created_on: "2026-11-06T13:51:48.056334Z", source: "wrangler", author_id: "x", author_email: "someone@example.com", has_preview: true },
  annotations: { "workers/alias": "staging", "workers/message": "26bc1d3", "workers/triggered_by": "version_upload" },
};
/** As `release preview` labels them now. */
const TAGGED = {
  id: "0a1b2c3d-0000-4000-8000-000000000025",
  number: 25,
  metadata: { created_on: "2026-11-06T16:00:00.000000Z", source: "wrangler", author_id: "x", author_email: "someone@example.com", has_preview: true },
  annotations: { "workers/alias": "staging", "workers/tag": "e49aa6a", "workers/message": "e49aa6a Merge pull request #27 from machinery-software/feat/mac-791-per-mac-lines", "workers/triggered_by": "version_upload" },
};
const withVersion = (v: object) => ({ ...DEPLOYMENT, versions: [{ version_id: (v as { id: string }).id, percentage: 100 }] });

describe("a version's tag and message", () => {
  it("tag the commit's short sha and nothing else", () => {
    expect(versionTag("e49aa6a")).toBe("e49aa6a");
    expect(versionTag("e49aa6a1b2c3d4e5")).toBe("e49aa6a1b2c3d4e5");
    for (const bad of ["", "HEAD", "e49aa6", "main", "E49AA6A", "e49aa6a dirty"]) expect(() => versionTag(bad), bad).toThrow(/not a commit sha/);
  });

  it("say '<sha> <first line of the subject>'", () => {
    expect(versionMessage("e49aa6a", "Merge pull request #27 from machinery-software/feat/mac-791-per-mac-lines")).toBe(
      "e49aa6a Merge pull request #27 from machinery-software/feat/mac-791-per-mac-lines",
    );
    expect(versionMessage("26bc1d3", "MAC-515: no-transform\n\nThe zone has twice…")).toBe("26bc1d3 MAC-515: no-transform");
    expect(versionMessage("26bc1d3", "  spaced  \n")).toBe("26bc1d3 spaced");
    expect(versionMessage("26bc1d3", "")).toBe("26bc1d3");
  });

  it("cut a long subject, never the sha", () => {
    const long = "x".repeat(200);
    const m = versionMessage("26bc1d3", long);
    expect(m).toHaveLength(MESSAGE_LIMIT);
    expect(m.startsWith("26bc1d3 xxxx")).toBe(true);
    expect(m.endsWith("…")).toBe(true);
  });

  it("are what wrangler versions upload is given, with the staging alias", () => {
    expect(uploadArgs("e49aa6a", "Merge pull request #27")).toEqual([
      "versions", "upload", "--preview-alias", "staging", "--tag", "e49aa6a", "--message", "e49aa6a Merge pull request #27",
    ]);
  });

  it("mark an upload from a dirty tree as dirty in the tag and the message, so it can never pass for the commit", () => {
    const args = uploadArgs("e49aa6a", "Merge pull request #27", { dirty: true });
    expect(args[args.indexOf("--tag") + 1]).toBe("e49aa6a-dirty");
    expect(args[args.indexOf("--message") + 1]).toBe("e49aa6a-dirty Merge pull request #27");
  });

  it("deploy a version at 100% with its own message, and --yes only when asked", () => {
    expect(deployArgs(TAGGED.id, "e49aa6a Merge pull request #27")).toEqual(["versions", "deploy", `${TAGGED.id}@100`, "--message", "e49aa6a Merge pull request #27"]);
    expect(deployArgs(TAGGED.id, "m", { yes: true })).toContain("--yes");
  });
});

describe("reading wrangler's JSON", () => {
  it("finds the version(s) a deployment serves, largest share first", () => {
    expect(liveVersions(DEPLOYMENT)).toEqual([{ versionId: "457f5dc1-b223-4034-8c89-70d8da9f4ef4", percentage: 100 }]);
    const split = { ...DEPLOYMENT, versions: [{ version_id: "a", percentage: 10 }, { version_id: "b", percentage: 90 }, { version_id: "c", percentage: 0 }] };
    expect(liveVersions(split).map((v) => v.versionId)).toEqual(["b", "a"]);
    expect(liveVersions({})).toEqual([]);
  });

  it("describes a tagged version by its tag, and an older one by the sha in its message, saying which", () => {
    expect(describeVersion(TAGGED)).toMatchObject({ id: TAGGED.id, number: 25, alias: "staging", tag: "e49aa6a", sha: "e49aa6a", tagged: true });
    expect(describeVersion(UNTAGGED)).toMatchObject({ number: 24, tag: null, sha: "26bc1d3", tagged: false, message: "26bc1d3" });
    expect(describeVersion({ ...UNTAGGED, annotations: { "workers/message": "first upload" } })).toMatchObject({ tag: null, sha: null, tagged: false });
    expect(shaFromMessage("26bc1d3 MAC-515: no-transform")).toBe("26bc1d3");
    expect(shaFromMessage("Merge e49aa6a")).toBeNull();
  });

  it("picks the newest version that carries the staging alias", () => {
    const older = { ...TAGGED, id: "older", number: 20 };
    const unaliased = { ...TAGGED, id: "live", number: 26, annotations: { "workers/tag": "ffffff1", "workers/message": "ffffff1 later" } };
    expect(stagingVersion([older, UNTAGGED, TAGGED, unaliased])?.id).toBe(TAGGED.id);
    expect(stagingVersion([unaliased])).toBeNull();
    expect(stagingVersion(undefined)).toBeNull();
  });

  it("prints a version on one line, the same way for production and staging", () => {
    expect(versionLine("production", { ...describeVersion(TAGGED), percentage: 100 })).toBe(
      `production  ${TAGGED.id}  #25  tag e49aa6a  "e49aa6a Merge pull request #27 from machinery-software/feat/mac-791-per-mac-lines"  2026-11-06T16:00:00.000000Z at 100%`,
    );
    expect(versionLine("staging", describeVersion(UNTAGGED))).toContain("untagged, message says 26bc1d3");
    expect(versionLine("staging", null)).toBe("staging     none");
  });
});

describe("the MATCH / BEHIND decision", () => {
  const live = (v: object, percentage = 100) => ({ ...describeVersion(v), percentage });

  it("is MATCH only when the one live version's commit is HEAD", () => {
    expect(decide([live(TAGGED)], "e49aa6a")).toEqual({ verdict: "MATCH", line: "MATCH" });
    expect(decide([live(TAGGED)], "e49aa6a1b2c3")).toEqual({ verdict: "MATCH", line: "MATCH" });
  });

  it("is BEHIND <sha> when the live version is some other commit, including today's branch build", () => {
    expect(decide([live(UNTAGGED)], "e49aa6a")).toEqual({ verdict: "BEHIND", line: "BEHIND 26bc1d3" });
    expect(decide([live(TAGGED)], "26bc1d3")).toEqual({ verdict: "BEHIND", line: "BEHIND e49aa6a" });
  });

  it("names an untagged, unlabelled version rather than guessing", () => {
    const bare = { ...UNTAGGED, annotations: { "workers/message": "first upload" } };
    expect(decide([live(bare)], "e49aa6a").line).toBe("BEHIND untagged version 457f5dc1");
  });

  it("is SPLIT, never MATCH, when traffic is divided", () => {
    const r = decide([live(TAGGED, 90), live(UNTAGGED, 10)], "e49aa6a");
    expect(r.verdict).toBe("SPLIT");
    expect(r.line).toBe("SPLIT 0a1b2c3d@90% 457f5dc1@10%");
    expect(decide([], "e49aa6a").verdict).toBe("SPLIT");
  });

  it("compares shas by prefix, at least seven characters, never by message", () => {
    expect(sameCommit("e49aa6a", "e49aa6a1b2c3d4")).toBe(true);
    expect(sameCommit("e49aa6a1b2c3d4", "e49aa6a")).toBe(true);
    expect(sameCommit("e49aa6a", "e49aa6b")).toBe(false);
    expect(sameCommit(null, "e49aa6a")).toBe(false);
    expect(sameCommit("e49aa6", "e49aa6")).toBe(false);
  });
});

describe("the status report", () => {
  it("prints production, staging, local and the verdict, and exits 0 only on MATCH", () => {
    const match = statusReport({ deployment: withVersion(TAGGED), views: { [TAGGED.id]: TAGGED }, list: [UNTAGGED, TAGGED], head: "e49aa6a", branch: "main" });
    expect(match.code).toBe(0);
    expect(match.lines).toEqual([
      versionLine("production", { ...describeVersion(TAGGED), percentage: 100 }),
      versionLine("staging", describeVersion(TAGGED)),
      "local       e49aa6a (main)",
      "MATCH",
    ]);
  });

  it("reports today's state: production at an unmerged branch build, main ahead of it", () => {
    const r = statusReport({ deployment: DEPLOYMENT, views: { [UNTAGGED.id]: UNTAGGED }, list: [UNTAGGED], head: "e49aa6a", branch: "main" });
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("BEHIND 26bc1d3");
    expect(r.lines[0]).toContain("untagged, message says 26bc1d3");
  });

  it("says when nothing serves traffic, and when staging has no version in the list", () => {
    const r = statusReport({ deployment: { ...DEPLOYMENT, versions: [] }, views: {}, list: [], head: "e49aa6a", branch: "main" });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("no version serves traffic");
    expect(r.lines[1]).toBe("staging     none");
  });
});
