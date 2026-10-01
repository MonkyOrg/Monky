import type {
  BotFormValues,
  LiveActionRecord,
  NativeLiveFormRecord,
  NativeLiveFormResponse,
  ServerEvent,
} from '@monky/shared';

export interface ICommunityRepository {
  settings(): { eventsEnabled: boolean; bannerPath: string | null; disabledAt: number | null };
  setSettings(eventsEnabled: boolean, bannerPath: string | null, disabledAt: number | null): void;
  event(id: string): ServerEvent | undefined;
  events(includeEnded?: boolean): ServerEvent[];
  saveEvent(event: ServerEvent): void;
  deleteEvent(id: string): void;
  interest(id: string, userId: string): { interested: boolean; interestedCount: number };
  interestedMembers(id: string, cursor: string | undefined, limit: number): Array<{ id: string; nickname: string; avatarPath: string | null }>;
  setInterest(id: string, userId: string, interested: boolean): void;
  liveActions(): LiveActionRecord[];
  liveAction(id: string): LiveActionRecord | undefined;
  saveLiveAction(action: LiveActionRecord): void;
  deleteLiveAction(id: string): void;
  activeNativeForms(now: number): NativeLiveFormRecord[];
  nativeForm(id: string): NativeLiveFormRecord | undefined;
  saveNativeForm(form: NativeLiveFormRecord): void;
  closeNativeForm(id: string, closedAt: number): NativeLiveFormRecord | undefined;
  closeExpiredNativeForms(now: number): NativeLiveFormRecord[];
  deleteClosedNativeForms(closedBefore: number): number;
  saveNativeFormResponse(id: string, userId: string, values: BotFormValues, now: number): NativeLiveFormResponse;
  nativeFormResponse(id: string, userId: string): NativeLiveFormResponse | undefined;
  nativeFormResponseCount(id: string): number;
  nativeFormResponses(id: string, cursor: string | undefined, limit: number): Array<{
    userId: string;
    nickname: string;
    avatarPath: string | null;
    response: NativeLiveFormResponse;
  }>;
  transaction<T>(action: () => T): T;
}
