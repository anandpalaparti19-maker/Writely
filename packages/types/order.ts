export enum OrderState {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  IN_PROGRESS = 'IN_PROGRESS',
  SUBMITTED = 'SUBMITTED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface IOrder {
  id: string;
  seekerId: string;
  writerId?: string;
  title: string;
  description: string;
  budget: number;
  status: OrderState;
  deadline: Date;
}
