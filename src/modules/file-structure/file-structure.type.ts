import { FileStructure, Prisma } from '@prisma/client';

export type CreateFileStructureParams = Omit<FileStructure, 'id' | 'createdAt'>;

export type ReplaceFileMethodParams = {
  path: string;
  userId: number;
  userRootContentPath: string;
  isFile: boolean;
};

export type IncreaseFileNameNumberMethodParams = {
  title: string;
  userId: number;
  isFile: boolean;
  parent?: FileStructure | null;
};

export type GetByMethodParamsInRepo = {
  depth?: number;
  title?: string;
  isFile?: boolean;
  userId?: number;
  path?: string;
  parentId?: number | null;
  isInBin?: boolean;
};
export type GetManyByMethodParamsInRepo = {
  parentId?: number;
  titleStartsWith?: string;
  depth?: number;
  title?: string;
  isFile?: boolean;
  userId?: number;
};

export type UpdateFSParams = Omit<Prisma.FileStructureUncheckedUpdateInput, 'id' | 'createdAt'>;
// export type UpdateFSParams = Omit<Prisma.FileStructureUpdateInput, 'createdAt'>;
