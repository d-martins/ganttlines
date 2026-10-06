import { MAX_FILE_BYTES, readWorkspaceFile, type LocalSource } from "@ganttlines/client";
import type { WorkspaceFile } from "@ganttlines/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { projectList } from "../api/queries";
import { Button } from "../ui/button";
import { ConfirmButton } from "../ui/confirm";
import { ErrorText } from "../ui/field";
import { FormDialog } from "../ui/form-dialog";
import { Section } from "../ui/section";
import { toast } from "../ui/toast";
import { forgetWorkspaceCache, workspace } from "../workspace";

function download(file: WorkspaceFile): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ganttlines-${file.exportedAt.slice(0, 10)}.ganttlines.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Export, import (replacing) and clear the workspace kept in this browser. */
export function LocalWorkspaceSection() {
  const client = useQueryClient();
  const projects = useQuery(projectList(true));
  const [problem, setProblem] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<WorkspaceFile | null>(null);
  const local = () => workspace() as LocalSource;
  const names = (projects.data ?? []).map((project) => `“${project.name}”`);
  const lost = names.length > 0 ? `This replaces ${names.join(", ")}.` : "This workspace is empty, so nothing is lost.";
  const refresh = () => forgetWorkspaceCache(client);

  const choose = async (file: File) => {
    setProblem(null);
    if (file.size > MAX_FILE_BYTES) return setProblem("This file is too big (over 50 MB)");
    try {
      setIncoming(await readWorkspaceFile(await file.text()));
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };

  return (
    <Section
      title="This browser's workspace"
      description="Your plans are saved in this browser only. Clearing the browser's site data deletes them, and Safari clears it after about 7 days without a visit — export to keep a copy."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => download(local().exportFile())}>Export</Button>
        <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
          Import…
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Import a workspace file"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void choose(file);
            }}
          />
        </label>
        <ConfirmButton
          label="Clear workspace"
          title="Clear this browser's workspace?"
          message={`${lost} Export first to keep a copy.`}
          confirmLabel="Clear"
          onConfirm={() => void local().clear().then(refresh)}
        />
      </div>
      <ErrorText>{problem}</ErrorText>
      <FormDialog
        open={incoming !== null}
        onOpenChange={(open) => (open ? undefined : setIncoming(null))}
        title="Replace this browser's workspace?"
        submitLabel="Replace"
        danger
        onSubmit={() => {
          const file = incoming;
          setIncoming(null);
          if (file)
            void local()
              .replaceWith(file)
              .then(() => {
                refresh();
                toast(`Opened ${file.projects.length} ${file.projects.length === 1 ? "project" : "projects"} from the file`);
              });
        }}
      >
        <p className="text-sm">
          {lost} The file has {incoming?.projects.length ?? 0} {incoming?.projects.length === 1 ? "project" : "projects"}.
        </p>
      </FormDialog>
    </Section>
  );
}
