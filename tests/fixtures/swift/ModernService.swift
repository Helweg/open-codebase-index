import Foundation
import struct Foundation.Date
import protocol Foundation.LocalizedError

/// Loads values asynchronously while remaining safe to pass across tasks.
protocol DataLoading: Sendable {
    associatedtype Output: Sendable

    init(client: APIClient)
    func load(id: UUID) async throws -> Output
    subscript(id: UUID) -> Output? { get }
}

enum LoadError: Error, LocalizedError {
    case missing(UUID)
    case invalidPayload

    var errorDescription: String? {
        switch self {
        case .missing(let id):
            "Missing value \(id)"
        case .invalidPayload:
            "Invalid payload"
        }
    }
}

actor ResponseCache<Value: Sendable> {
    private var values: [UUID: Value] = [:]

    func value(for id: UUID) -> Value? {
        values[id]
    }

    func insert(_ value: Value, for id: UUID) {
        values[id] = value
    }

    subscript(id: UUID) -> Value? {
        values[id]
    }
}

struct User: Codable, Sendable {
    let id: UUID
    let name: String
    let refreshedAt: Date
}

struct APIClient: Sendable {
    static let shared = APIClient()

    func fetch<Value: Decodable & Sendable>(
        _ type: Value.Type,
        id: UUID
    ) async throws -> Value {
        try await Task.sleep(for: .milliseconds(10))
        return try JSONDecoder().decode(type, from: Data())
    }
}

/** Repository backed by an actor-isolated cache. */
final class UserRepository: DataLoading {
    typealias Output = User

    private let client: APIClient
    private let cache = ResponseCache<User>()

    required init(client: APIClient) {
        self.client = client
    }

    deinit {
        print("UserRepository released")
    }

    subscript(id: UUID) -> User? {
        nil
    }

    func load(id: UUID) async throws -> User {
        if let cached = await cache.value(for: id) {
            return cached
        }

        let user = try await client.fetch(User.self, id: id)
        await cache.insert(user, for: id)
        return user
    }
}

extension UserRepository: CustomStringConvertible {
    static func live() -> Self {
        .init(client: .shared)
    }

    var description: String {
        "UserRepository"
    }

    func loadNames(ids: [UUID]) async throws -> [String] {
        try await withThrowingTaskGroup(of: User.self) { group in
            for id in ids {
                group.addTask {
                    try await self.load(id: id)
                }
            }

            var users: [User] = []
            for try await user in group {
                users.append(user)
            }
            return users.map { $0.name }
        }
    }
}

enum LoadState: Sendable {
    case idle
    case loading
    case loaded(User)
    case failed
}

@MainActor
final class UsersViewModel {
    private let repository: UserRepository
    private(set) var state: LoadState = .idle

    init(repository: UserRepository) {
        self.repository = repository
    }

    func refresh(id: UUID) async {
        state = .loading
        let user = try? await repository.load(id: id)
        state = if let user {
            .loaded(user)
        } else {
            .failed
        }
    }
}

struct NoncopyableToken: ~Copyable {
    borrowing func inspect() -> String {
        "token"
    }

    consuming func consume() {}
}

enum DecodeFailure: Error {
    case invalid
}

func decode<Value: Decodable>(
    _ type: Value.Type,
    from data: Data
) throws(DecodeFailure) -> Value {
    throw .invalid
}

func collect<each Value>(
    _ values: repeat each Value
) -> (repeat each Value) {
    (repeat each values)
}

func makeRepository() -> UserRepository {
    UserRepository.live()
}
