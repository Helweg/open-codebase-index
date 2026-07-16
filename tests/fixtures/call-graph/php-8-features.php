<?php

#[\Attribute(\Attribute::TARGET_CLASS | \Attribute::TARGET_PARAMETER)]
final class FeatureFlag
{
    public function __construct(public readonly string $name) {}
}

interface Cacheable
{
    public function remember(string $key, callable $loader): mixed;
}

interface Loggable
{
    public function log(string $message): void;
}

trait Timestamps
{
    public function touch(): void
    {
        $this->updatedAt = now();
    }
}

#[FeatureFlag(name: 'job')]
readonly class Job
{
    use Timestamps;

    public function __construct(
        #[FeatureFlag(name: 'identifier')]
        public int|string $id,
        private (Cacheable&Loggable)|null $service = null,
    ) {}

    public function describe(?User $user): string
    {
        $label = $user?->displayName(prefix: 'job');

        return match ($label) {
            null => fallback(reason: 'missing'),
            default => normalize(value: $label),
        };
    }
}

final class Profile
{
    public private(set) string $title = 'Untitled';

    public string $slug {
        get => normalize(value: $this->title);
    }

    public function format(string $value): string
    {
        return $value;
    }
}

enum Status: string implements JsonSerializable
{
    public const string LABEL = 'status';

    case Pending = 'pending';
    case Done = 'done';

    public function jsonSerialize(): string
    {
        return formatStatus(status: $this);
    }
}

#[\Deprecated]
const LEGACY_STATUS = 'legacy';

function makeJob(Cacheable&Loggable $service, int|string $id): Job
{
    return new Job(id: $id, service: $service);
}

function statusConstant(string $name): string
{
    return Status::{$name};
}

function freshProfile(): string
{
    return new Profile()->format('fresh');
}

function callableReferences(Profile $profile): array
{
    return [
        callableOnly(...),
        $profile->methodOnly(...),
        Formatter::staticOnly(...),
    ];
}

function pipeline(Profile $profile, string $value): string
{
    return $value
        |> (trim(...))
        |> strtolower(...)
        |> $profile->format(...)
        |> Formatter::create(...);
}
