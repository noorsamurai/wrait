import type { Presence, User } from "@lokalen/protocol";

/** Stable hue per person, derived from the id so it survives renames. */
function hueOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

interface AvatarProps {
  user: Pick<User, "id" | "initials" | "displayName">;
  presence?: Presence;
  large?: boolean;
}

export function Avatar({ user, presence, large }: AvatarProps) {
  return (
    <div
      className={large ? "avatar avatar--lg" : "avatar"}
      style={{ ["--hue" as string]: hueOf(user.id) }}
      aria-hidden
    >
      {user.initials}
      {presence ? <span className="avatar__dot" data-presence={presence} /> : null}
    </div>
  );
}
