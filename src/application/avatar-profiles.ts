export interface AvatarProfile {
  id: string;
  userId: string;
  heygenAvatarId: string;
  name: string;
  sourceFileId?: string | null;
  voice?: "male" | "female" | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AvatarProfileStore {
  list(userId: string): Promise<AvatarProfile[]>;
  get(userId: string, id: string): Promise<AvatarProfile | undefined>;
  create(input: Omit<AvatarProfile, "id" | "createdAt" | "updatedAt">): Promise<AvatarProfile>;
  updateVoice(userId: string, id: string, voice: "male" | "female"): Promise<void>;
}
