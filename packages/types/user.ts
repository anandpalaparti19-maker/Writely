export enum UserRole {
  SEEKER = 'SEEKER',
  WRITER = 'WRITER',
  ADMIN = 'ADMIN',
}

export interface IUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
}
