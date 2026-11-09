import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { backupID, bindingSchema, digest, indexSchema, label, revisionID, revisionSchema, transferSchema } from "./model.js";
import { workspaceSchema } from "./config.js";

const token = z.string().min(1);
const project = label.optional();
const method = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output,
  errors: { operation_failed: z.object({ code: z.string() }) } });
const settingsOutput = z.object({ projects: z.array(label), workspaces: z.array(workspaceSchema), token: digest,
  configFile: z.string(), directory: z.string(), defaultProject: project, currentWorkspaceIndex: z.number().int().min(-1) });
export const WebdavRPC = Rpc.define({
  id: "webdav-sync",
  events: {},
  methods: {
    settings: method(z.object({}).strict(), settingsOutput),
    saveSettings: method(z.object({ projects: z.array(label), workspaces: z.array(workspaceSchema), expectedToken: digest }).strict(), settingsOutput),
    overview: method(z.object({ sessionID: z.string().optional() }).strict(), z.object({
      index: indexSchema, token, binding: bindingSchema.optional(),
      settings: z.object({ projects: z.array(label), defaultProject: project, device: label, sanitize: z.boolean(),
        opencodeVersion: label, pluginVersion: label }),
      configFile: z.string(), warning: z.string().optional(),
    })),
    upload: method(z.object({ data: transferSchema, target: backupID.optional(), project, expectedToken: token,
      allowConflict: z.boolean().optional(), allowVersionMismatch: z.boolean().optional() }).strict(),
    z.object({ status: z.enum(["uploaded", "unchanged"]), backupID, revisionID })),
    download: method(z.object({ backupID, revisionID, expectedToken: token, allowVersionMismatch: z.boolean().optional() }).strict(),
      z.object({ data: transferSchema, revision: revisionSchema })),
    remember: method(z.object({ sessionID: z.string().startsWith("ses"), backupID, revisionID, expectedToken: token }).strict(), z.object({ ok: z.literal(true) })),
    edit: method(z.object({ backupID, title: label, project, expectedToken: token }).strict(), z.object({ ok: z.literal(true) })),
    remove: method(z.object({ backupID, revisionID: revisionID.optional(), expectedToken: token }).strict(),
      z.object({ ok: z.literal(true), failed: z.array(z.string()) })),
    scan: method(z.object({}).strict(), z.object({ paths: z.array(z.string()), token, scanToken: digest })),
    clean: method(z.object({ expectedToken: token, scanToken: digest }).strict(), z.object({ deleted: z.number(), failed: z.array(z.string()) })),
    test: method(z.object({}).strict(), z.object({ ok: z.literal(true), indexExists: z.boolean(), sessions: z.number() })),
  },
});
