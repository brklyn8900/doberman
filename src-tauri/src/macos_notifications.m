#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>

@interface DobermanNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation DobermanNotificationDelegate

+ (instancetype)sharedDelegate {
    static DobermanNotificationDelegate *sharedDelegate = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        sharedDelegate = [[DobermanNotificationDelegate alloc] init];
    });
    return sharedDelegate;
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:
             (void (^)(UNNotificationPresentationOptions options))completionHandler {
    UNNotificationPresentationOptions options = UNNotificationPresentationOptionSound;
    if (@available(macOS 11.0, *)) {
        options |= UNNotificationPresentationOptionBanner;
        options |= UNNotificationPresentationOptionList;
    }
    completionHandler(options);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    completionHandler();
}

@end

static void DobermanRunOnMainThreadSync(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }

    dispatch_sync(dispatch_get_main_queue(), block);
}

static void DobermanEnsureNotificationCenterDelegate(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        DobermanRunOnMainThreadSync(^{
            [UNUserNotificationCenter currentNotificationCenter].delegate =
                [DobermanNotificationDelegate sharedDelegate];
        });
    });
}

static NSError *DobermanError(NSString *description) {
    return [NSError errorWithDomain:@"io.armana.doberman.notifications"
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey : description}];
}

static BOOL DobermanEnsureAuthorization(NSError **error) {
    __block BOOL granted = NO;
    __block NSError *requestError = nil;
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];

    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
            requestError =
                DobermanError(@"macOS notifications are disabled for Doberman in System Settings");
            dispatch_semaphore_signal(semaphore);
            return;
        }

        if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert |
                                                     UNAuthorizationOptionBadge |
                                                     UNAuthorizationOptionSound)
                                  completionHandler:^(BOOL didGrant, NSError *_Nullable err) {
                                      granted = didGrant;
                                      requestError = err;
                                      if (!didGrant && requestError == nil) {
                                          requestError = DobermanError(
                                              @"macOS notification permission was not granted");
                                      }
                                      dispatch_semaphore_signal(semaphore);
                                  }];
            return;
        }

        granted = YES;
        dispatch_semaphore_signal(semaphore);
    }];

    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

    if (!granted && error != NULL) {
        *error = requestError ?: DobermanError(@"macOS notification permission was not granted");
    }

    return granted;
}

static char *DobermanCopyCString(NSString *value) {
    const char *utf8 = [value UTF8String];
    if (utf8 == NULL) {
        return NULL;
    }

    size_t length = strlen(utf8) + 1;
    char *copy = malloc(length);
    if (copy == NULL) {
        return NULL;
    }

    memcpy(copy, utf8, length);
    return copy;
}

int doberman_send_user_notification(const char *identifier,
                                    const char *title,
                                    const char *body,
                                    char **error_out) {
    @autoreleasepool {
        if (error_out != NULL) {
            *error_out = NULL;
        }

        DobermanEnsureNotificationCenterDelegate();

        NSError *authorizationError = nil;
        if (!DobermanEnsureAuthorization(&authorizationError)) {
            if (error_out != NULL && authorizationError != nil) {
                *error_out = DobermanCopyCString(authorizationError.localizedDescription);
            }
            return 0;
        }

        NSString *identifierString =
            identifier != NULL ? [NSString stringWithUTF8String:identifier] : [[NSUUID UUID] UUIDString];
        NSString *titleString = title != NULL ? [NSString stringWithUTF8String:title] : @"";
        NSString *bodyString = body != NULL ? [NSString stringWithUTF8String:body] : @"";

        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = titleString;
        content.body = bodyString;
        content.sound = [UNNotificationSound defaultSound];

        UNTimeIntervalNotificationTrigger *trigger =
            [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:1 repeats:NO];
        UNNotificationRequest *request =
            [UNNotificationRequest requestWithIdentifier:identifierString
                                                 content:content
                                                 trigger:trigger];

        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
        __block NSError *sendError = nil;

        [[UNUserNotificationCenter currentNotificationCenter]
            addNotificationRequest:request
             withCompletionHandler:^(NSError *_Nullable err) {
                 sendError = err;
                 dispatch_semaphore_signal(semaphore);
             }];

        dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

        if (sendError != nil) {
            if (error_out != NULL) {
                *error_out = DobermanCopyCString(sendError.localizedDescription);
            }
            return 0;
        }

        return 1;
    }
}

void doberman_notifications_free_string(char *value) {
    free(value);
}
