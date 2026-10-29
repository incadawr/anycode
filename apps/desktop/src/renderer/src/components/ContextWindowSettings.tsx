import type { ProviderConnection, SettingsSnapshot } from "../../../shared/settings.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";
import { customProviderCatalogEntries } from "./SettingsScreen.js";

/** The session's model may differ from the connection's default. */
export default function ContextWindowSettings({ snapshot, connection, model, onClose }: {
  snapshot: SettingsSnapshot;
  connection: ProviderConnection;
  model: string;
  onClose(): void;
}) {
  return <ConnectionDrawer open mode="edit" initialFocus="context"
    editConnection={{ ...connection, model }}
    catalog={[...(snapshot.catalog ?? []), ...customProviderCatalogEntries(snapshot.settings.provider.custom ?? [])]}
    connections={snapshot.settings.provider.connections} secrets={snapshot.secrets} readOnly={snapshot.readOnly}
    onClose={onClose} />;
}
