import type { ResourceDto } from "@ganttlines/protocol";
import { Plus, UserX } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "../api/client";
import { useCreateResource } from "../api/queries";
import { Avatar } from "../ui/avatar";
import { SearchSelect, type SearchOption } from "../ui/search-select";
import { toast } from "../ui/toast";

/**
 * Pick one assignee: type to filter, arrows to move, Enter to choose; opens on the current one.
 * Inactive people are hidden unless already assigned. People who may add team members can create
 * one from what they typed.
 */
export function AssigneePicker({
  value,
  resources,
  canCreate,
  onChange,
  trigger,
}: {
  value: string | null;
  resources: readonly ResourceDto[];
  canCreate: boolean;
  onChange: (resourceId: string | null) => void;
  trigger: ReactNode;
}) {
  const create = useCreateResource();
  const pick = (resourceId: string | null) => resourceId !== value && onChange(resourceId);
  const options = (query: string): SearchOption[] => {
    const needle = query.toLocaleLowerCase();
    const people = resources.filter((resource) => (!resource.inactive || resource.id === value) && resource.name.toLocaleLowerCase().includes(needle));
    return [
      ...(needle ? [] : [{ key: "none", label: "Unassigned", leading: <UserX size={16} className="text-muted" />, current: value === null, onChoose: () => pick(null) }]),
      ...people.map((resource) => ({
        key: resource.id,
        label: resource.name,
        leading: <Avatar name={resource.name} color={resource.avatarColor} size={20} />,
        current: resource.id === value,
        onChoose: () => pick(resource.id),
      })),
      ...(canCreate && needle && !resources.some((resource) => resource.name.toLocaleLowerCase() === needle)
        ? [
            {
              key: "create",
              label: `New team member “${query}”`,
              leading: <Plus size={16} className="text-muted" />,
              onChoose: () =>
                create.mutate(
                  { name: query },
                  {
                    onSuccess: ({ resource }) => onChange(resource.id),
                    onError: (error) => toast(`Couldn't add the team member: ${errorMessage(error)}`, { tone: "error" }),
                  },
                ),
            },
          ]
        : []),
    ];
  };
  return <SearchSelect trigger={trigger} options={options} searchLabel="Find a person" placeholder="Find a person…" empty="Nobody matches." />;
}
