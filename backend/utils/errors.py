"""
Error Handling Utilities

Provides structured error handling, retry logic, and graceful fallbacks
for API operations.
"""

import logging
import asyncio
from typing import TypeVar, Callable, Any, Optional, List
from dataclasses import dataclass
from enum import Enum
from functools import wraps


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class ErrorSeverity(str, Enum):
    """Error severity levels."""
    LOW = "low"  # Expected, can continue
    MEDIUM = "medium"  # Degraded functionality
    HIGH = "high"  # Critical, requires attention
    FATAL = "fatal"  # App cannot continue


class ErrorCategory(str, Enum):
    """Error categories for debugging."""
    NETWORK = "network"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    PARSE = "parse"
    VALIDATION = "validation"
    NOT_FOUND = "not_found"
    SERVER = "server_error"
    CACHE = "cache"
    UNKNOWN = "unknown"


@dataclass
class APIError:
    """Structured API error information."""
    message: str
    category: ErrorCategory
    severity: ErrorSeverity
    source: str
    retryable: bool = False
    details: Optional[dict] = None
    original_error: Optional[Exception] = None
    
    def to_dict(self) -> dict:
        return {
            "message": self.message,
            "category": self.category.value,
            "severity": self.severity.value,
            "source": self.source,
            "retryable": self.retryable,
            "details": self.details or {}
        }


class MetadataFetchError(Exception):
    """Custom exception for metadata fetch failures."""
    
    def __init__(self, api_error: APIError):
        self.api_error = api_error
        super().__init__(api_error.message)


class PartialDataError(Exception):
    """Raised when partial data is available but some sources failed."""
    
    def __init__(self, message: str, partial_data: Any, errors: List[APIError]):
        self.partial_data = partial_data
        self.errors = errors
        super().__init__(message)


def classify_error(error: Exception, source: str) -> APIError:
    """Classify an exception into a structured APIError."""
    error_str = str(error).lower()
    
    # Network/timeout errors
    if any(kw in error_str for kw in ["timeout", "timed out", "connection", "connect"]):
        return APIError(
            message=f"Network timeout from {source}: {str(error)}",
            category=ErrorCategory.TIMEOUT,
            severity=ErrorSeverity.MEDIUM,
            source=source,
            retryable=True,
            original_error=error
        )
    
    # Rate limiting
    if any(kw in error_str for kw in ["rate limit", "429", "too many requests"]):
        return APIError(
            message=f"Rate limited by {source}",
            category=ErrorCategory.RATE_LIMIT,
            severity=ErrorSeverity.MEDIUM,
            source=source,
            retryable=True,
            original_error=error
        )
    
    # Not found
    if any(kw in error_str for kw in ["not found", "404", "no results"]):
        return APIError(
            message=f"Resource not found at {source}: {str(error)}",
            category=ErrorCategory.NOT_FOUND,
            severity=ErrorSeverity.LOW,
            source=source,
            retryable=False,
            original_error=error
        )
    
    # Parse errors
    if any(kw in error_str for kw in ["json", "parse", "decode", "invalid format"]):
        return APIError(
            message=f"Failed to parse response from {source}: {str(error)}",
            category=ErrorCategory.PARSE,
            severity=ErrorSeverity.HIGH,
            source=source,
            retryable=False,
            original_error=error
        )
    
    # Server errors
    if any(kw in error_str for kw in ["500", "502", "503", "504", "server error"]):
        return APIError(
            message=f"Server error at {source}: {str(error)}",
            category=ErrorCategory.SERVER,
            severity=ErrorSeverity.MEDIUM,
            source=source,
            retryable=True,
            original_error=error
        )
    
    # Default
    return APIError(
        message=f"Error from {source}: {str(error)}",
        category=ErrorCategory.UNKNOWN,
        severity=ErrorSeverity.MEDIUM,
        source=source,
        retryable=False,
        original_error=error
    )


T = TypeVar('T')


async def with_retry(
    func: Callable[..., Any],
    *args,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    exponential_base: float = 2.0,
    retryable_exceptions: tuple = (Exception,),
    on_retry: Optional[Callable[[int, Exception], None]] = None,
    **kwargs
) -> T:
    """
    Execute a function with retry logic.
    
    Args:
        func: Async function to call
        max_retries: Maximum retry attempts
        base_delay: Initial delay between retries
        max_delay: Maximum delay between retries
        exponential_base: Exponential backoff multiplier
        retryable_exceptions: Tuple of exception types to retry
        on_retry: Callback on each retry (attempt_number, error)
    """
    last_error = None
    
    for attempt in range(max_retries + 1):
        try:
            return await func(*args, **kwargs)
        except retryable_exceptions as e:
            last_error = e
            
            if attempt >= max_retries:
                logger.warning(f"Max retries ({max_retries}) exceeded")
                raise
            
            # Calculate delay with exponential backoff
            delay = min(base_delay * (exponential_base ** attempt), max_delay)
            
            if on_retry:
                on_retry(attempt + 1, e)
            
            logger.info(f"Retry {attempt + 1}/{max_retries} after {delay:.1f}s - {str(e)}")
            await asyncio.sleep(delay)
    
    # Should never reach here
    raise last_error if last_error else RuntimeError("Unexpected retry failure")


def safe_get(data: dict, *keys, default=None):
    """Safely navigate nested dictionaries."""
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current if current is not None else default


def log_error(error: APIError, context: Optional[dict] = None):
    """Log an error with context."""
    log_data = {
        "error": error.to_dict(),
        "context": context or {}
    }
    
    if error.severity == ErrorSeverity.FATAL:
        logger.critical(f"FATAL ERROR: {error.message}", extra=log_data)
    elif error.severity == ErrorSeverity.HIGH:
        logger.error(f"HIGH ERROR: {error.message}", extra=log_data)
    elif error.severity == ErrorSeverity.MEDIUM:
        logger.warning(f"MEDIUM ERROR: {error.message}", extra=log_data)
    else:
        logger.info(f"LOW ERROR: {error.message}", extra=log_data)


class ErrorContext:
    """Context manager for error tracking."""
    
    def __init__(self, operation: str, source: str, raise_on_error: bool = True):
        self.operation = operation
        self.source = source
        self.raise_on_error = raise_on_error
        self.error: Optional[APIError] = None
    
    async def __aenter__(self):
        logger.debug(f"Starting operation: {self.operation} from {self.source}")
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if exc_val:
            self.error = classify_error(exc_val, self.source)
            self.error.details = {"operation": self.operation}
            log_error(self.error)
            
            if self.raise_on_error:
                raise MetadataFetchError(self.error)
            return True  # Suppress exception
        
        logger.debug(f"Completed operation: {self.operation}")
        return False
