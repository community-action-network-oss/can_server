export interface Rendered {
  subject: string;
  text: string;
}

export function signInCode(code: string): Rendered {
  return {
    subject: 'Your CAN sign-in code',
    text: `Your CAN sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
  };
}
