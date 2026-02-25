export interface PaymentsUser {
  id: string
  email?: string
}

export interface IPaymentsAuthProvider {
  getUser(): Promise<PaymentsUser | null>
}
