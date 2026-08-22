import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { LoginPage } from "../../src/auth/LoginPage.js";

describe("LoginPage", () => {
  test("submits an email and password with appropriate autofill hints", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginPage onLogin={onLogin} />);

    const email = screen.getByLabelText("邮箱");
    const password = screen.getByLabelText("密码");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    await user.type(email, "person@example.com");
    await user.type(password, "not-retained-password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(onLogin).toHaveBeenCalledWith("person@example.com", "not-retained-password");
    expect(email).toHaveValue("person@example.com");
    expect(password).toHaveValue("");
  });

  test("keeps the email and clears only the password after a failed login", async () => {
    const user = userEvent.setup();
    render(<LoginPage onLogin={vi.fn().mockRejectedValue(new Error("raw secret"))} />);

    const email = screen.getByLabelText("邮箱");
    const password = screen.getByLabelText("密码");
    await user.type(email, "person@example.com");
    await user.type(password, "not-retained-password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("登录未完成，请检查网络或密码后重试。");
    expect(email).toHaveValue("person@example.com");
    expect(password).toHaveValue("");
  });

  test("preserves the offline login copy", () => {
    render(<LoginPage onLogin={vi.fn()} offline />);

    expect(screen.getByRole("heading", { name: "离线解锁需要登录" })).toBeVisible();
  });
});
