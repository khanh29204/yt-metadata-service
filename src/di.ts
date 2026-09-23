/**
 * Mini DI container theo cơ chế NestJS: @Injectable() + constructor injection
 * qua reflect-metadata (design:paramtypes). Container tự đệ resolves params.
 * ponytail: singleton đơn giản, đủ dùng; cần scope/qualifier thì thay bằng inversify.
 */
import "reflect-metadata";

type Constructable<T> = new (...args: never[]) => T;

export function Injectable(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata("di:injectable", true, target);
  };
}

export class Container {
  private instances = new Map<Constructable<unknown>, unknown>();

  /** Resolve một class (tự tạo + inject các dependency, cache singleton). */
  resolve<T>(cls: Constructable<T>): T {
    if (this.instances.has(cls)) return this.instances.get(cls) as T;

    const paramTypes: Constructable<unknown>[] =
      Reflect.getMetadata("design:paramtypes", cls) ?? [];
    const deps = paramTypes.map((p) => {
      if (!p || !Reflect.getMetadata("di:injectable", p))
        throw new Error(`DI: cannot resolve ${String(p)} for ${cls.name} — thiếu @Injectable()?`);
      return this.resolve(p);
    });

    const instance = new cls(...(deps as never[]));
    this.instances.set(cls, instance);
    return instance;
  }
}

export const container = new Container();
