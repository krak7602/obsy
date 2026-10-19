// SecretStorage: does the API exist, do set, get, and list work, how does a
// secret "delete" behave (the 1.14.4 typings have no delete method), and does
// a secret value ever reach the plugin's data.json.
import type { Log, SectionOutput } from '../section';
import { statusOf, step } from '../section';

/** The `SecretStorage` methods in the obsidian 1.14.4 typings. */
export interface SecretStorageLike {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
}

export const TEST_SECRET_ID = 'obsy-probe-test';
export const MARKER_SECRET_ID = 'obsy-probe-marker';

export interface SecretsSectionInput {
  secrets: SecretStorageLike | undefined;
  /** The text of the plugin's data.json, or `null` when it does not exist. */
  readPluginData(): Promise<string | null>;
  /** How many localStorage values contain `value`, or `null` when localStorage is not readable. */
  countInLocalStorage(value: string): number | null;
  /** Secret names from the probe settings. Empty when not set. */
  credentialNames: { accessKeyId: string; secretAccessKey: string };
  /** A random test value. The caller adds it to the redaction list. */
  testValue: string;
  log: Log;
}

/** Whether `secrets` has the three methods. */
export function isSecretStorage(value: unknown): value is SecretStorageLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ['setSecret', 'getSecret', 'listSecrets'].every(
    (name) => typeof candidate[name] === 'function',
  );
}

export async function runSecretsSection(input: SecretsSectionInput): Promise<SectionOutput> {
  const secrets = input.secrets;
  const api = {
    secretStorage: secrets !== undefined,
    methods: secrets === undefined ? [] : ['setSecret', 'getSecret', 'listSecrets'],
    deleteMethod:
      secrets !== undefined &&
      typeof (secrets as unknown as Record<string, unknown>)['deleteSecret'] === 'function',
  };
  if (secrets === undefined) return { status: 'unavailable', data: { api }, errors: [] };

  const value = input.testValue;
  const second = `${value}x`;
  input.log('Secret storage: set, get, list');
  const steps = [
    await step('setSecret then getSecret returns the value', async () => {
      secrets.setSecret(TEST_SECRET_ID, value);
      return { passed: secrets.getSecret(TEST_SECRET_ID) === value };
    }),
    await step('listSecrets includes the ID', async () => {
      const ids = secrets.listSecrets();
      return { passed: ids.includes(TEST_SECRET_ID), secretCount: ids.length };
    }),
    await step('setSecret overwrites the value', async () => {
      secrets.setSecret(TEST_SECRET_ID, second);
      return { passed: secrets.getSecret(TEST_SECRET_ID) === second };
    }),
    await step('getSecret of an unknown ID returns null', async () => ({
      passed: secrets.getSecret('obsy-probe-never-set') === null,
    })),
    await step('the value is not in data.json', async () => {
      const text = await input.readPluginData();
      return {
        passed: text === null || (!text.includes(value) && !text.includes(second)),
        dataJsonExists: text !== null,
      };
    }),
    await step('where the value is stored (informational)', async () => {
      const count = input.countInLocalStorage(second);
      return {
        passed: true,
        localStorageReadable: count !== null,
        plaintextInLocalStorage: count === null ? null : count > 0,
      };
    }),
    await step('"delete" by setting an empty value', async () => {
      // The typings have no delete method. Record what an empty value does.
      secrets.setSecret(TEST_SECRET_ID, '');
      const after = secrets.getSecret(TEST_SECRET_ID);
      return {
        passed: after === '' || after === null,
        getSecretAfter: after === null ? 'null' : after === '' ? 'empty string' : 'other value',
        stillListed: secrets.listSecrets().includes(TEST_SECRET_ID),
      };
    }),
    await step('the probe credentials resolve, and are not in data.json', async () => {
      const text = (await input.readPluginData()) ?? '';
      const resolve = (name: string): { resolved: boolean; inDataJson: boolean } => {
        if (name === '') return { resolved: false, inDataJson: false };
        const secret = secrets.getSecret(name);
        const resolved = secret !== null && secret !== '';
        return { resolved, inDataJson: resolved && text.includes(secret) };
      };
      const accessKeyId = resolve(input.credentialNames.accessKeyId);
      const secretAccessKey = resolve(input.credentialNames.secretAccessKey);
      return {
        passed: !accessKeyId.inDataJson && !secretAccessKey.inDataJson,
        accessKeyId,
        secretAccessKey,
      };
    }),
  ];
  return { status: statusOf(steps), data: { api, steps }, errors: [] };
}
