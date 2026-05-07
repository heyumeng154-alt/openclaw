import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "./official-external-plugin-catalog.js";

export type OfficialExternalPluginRepairHint = {
  pluginId: string;
  channelId?: string;
  label: string;
  installSpec: string;
  installCommand: string;
  doctorFixCommand: string;
  repairHint: string;
};

export function resolveOfficialExternalPluginRepairHint(
  pluginIdOrChannelId: string,
): OfficialExternalPluginRepairHint | null {
  const entry = getOfficialExternalPluginCatalogEntry(pluginIdOrChannelId);
  if (!entry) {
    return null;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  const npmSpec = install?.npmSpec?.trim();
  const clawhubSpec = install?.clawhubSpec?.trim();
  const installSpec =
    install?.defaultChoice === "clawhub" ? (clawhubSpec ?? npmSpec) : (npmSpec ?? clawhubSpec);
  if (!installSpec) {
    return null;
  }
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const pluginId = resolveOfficialExternalPluginId(entry) ?? pluginIdOrChannelId.trim();
  const channelId = manifest?.channel?.id?.trim();
  const label = resolveOfficialExternalPluginLabel(entry);
  const installCommand = `openclaw plugins install ${installSpec}`;
  const doctorFixCommand = "openclaw doctor --fix";
  return {
    pluginId,
    ...(channelId ? { channelId } : {}),
    label,
    installSpec,
    installCommand,
    doctorFixCommand,
    repairHint: `Install the official external plugin with: ${installCommand}, or run: ${doctorFixCommand}.`,
  };
}
