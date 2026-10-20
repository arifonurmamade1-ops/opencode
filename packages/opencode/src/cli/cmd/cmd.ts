import type { Argv, CommandModule } from "yargs"

export type WithDoubleDash<T> = T & { "--"?: string[]; _?: Array<string | number> }

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input
}

type AsyncCommandModule<T, U> = Omit<CommandModule<T, WithDoubleDash<U>>, "builder"> & {
  builder?: (args: Argv<T>) => Argv<T> | Promise<Argv<T>>
}

/**
 * yargs awaits builders that return a promise, but its public CommandModule
 * type only models the synchronous form. Keep the cast at this boundary so a
 * command can defer loading its subcommands until yargs actually asks for them.
 */
export function lazyCmd<T, U>(input: AsyncCommandModule<T, U>): CommandModule<T, WithDoubleDash<U>> {
  return input as CommandModule<T, WithDoubleDash<U>>
}
